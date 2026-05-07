// createTrackedMessage / createTrackedStream — the call-site funnel.
// Routes every AI call through the Vercel AI SDK using the provider/model/key
// resolved from ai_provider_settings for the feature's tier. Returns an
// Anthropic-shaped Message so call sites stay unchanged.

import type Anthropic from "@anthropic-ai/sdk";
import { generateText, streamText } from "ai";
import type { StreamTextResult, ToolSet, GenerateTextResult } from "ai";
import { resolveTier } from "./tier-resolver";
import { getModel } from "./providers";
import { anthropicToAiSdk, aiSdkToAnthropic, type AnthropicCallParams } from "./translators";
import { getPricing, getPricingFromCatalog, type Provider } from "./model-catalog";
import type { Tier } from "./feature-tiers";

const VALID_TIERS: ReadonlySet<Tier> = new Set(["basic", "medium", "complex"]);
const VALID_PROVIDERS: ReadonlySet<Provider> = new Set([
  "anthropic",
  "openai",
  "google",
  "openrouter",
]);

// Pull a typed tier override out of the loose `meta` blob. Callers (agent
// runtime) pass `meta.tierOverride` to force a specific tier independent of
// the featureName-based default.
function extractTierOverride(meta: Record<string, unknown> | undefined): Tier | undefined {
  const raw = meta?.tierOverride;
  if (typeof raw === "string" && VALID_TIERS.has(raw as Tier)) return raw as Tier;
  return undefined;
}

// Pull a typed provider override out of the loose `meta` blob. Caller (agent
// runtime) sources this from agent_skills.provider_override so the resolver
// re-reads ai_provider_settings for the chosen provider's row.
function extractProviderOverride(meta: Record<string, unknown> | undefined): Provider | undefined {
  const raw = meta?.providerOverride;
  if (typeof raw === "string" && VALID_PROVIDERS.has(raw as Provider)) return raw as Provider;
  return undefined;
}

// Pull the already-decrypted skill API key out of `meta`. Caller (agent
// runtime) sources this from agent_skills.api_key_cipher (decrypted by the
// prompt-builder). When set, tier-resolver uses it directly — it never reaches
// into another tier's row for a key.
function extractApiKeyOverride(meta: Record<string, unknown> | undefined): string | undefined {
  const raw = meta?.apiKeyOverride;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

// Pull the optional skill base URL override out of `meta`. Used for
// self-hosted OpenRouter proxies / Vertex regions when the skill carries
// its own provider+key combo.
function extractBaseUrlOverride(meta: Record<string, unknown> | undefined): string | undefined {
  const raw = meta?.baseUrlOverride;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

// ─── Cost calculation (cache-aware, Anthropic only) ──────────────────────────
const CACHE_CREATION_MULTIPLIER = 1.25; // 25% premium on cache writes (5m)
const CACHE_READ_MULTIPLIER = 0.10;     // 90% discount on cache reads

function calcCost(tokens: number, pricePerM: number): number {
  return (tokens / 1_000_000) * pricePerM;
}

function computeInputCost(
  usage: {
    input_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
  inputPerM: number,
): number {
  const inputTokens = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  // Anthropic API: input_tokens INCLUDES cache_read but EXCLUDES cache_creation.
  const uncachedInput = Math.max(0, inputTokens - cacheRead);
  return calcCost(uncachedInput, inputPerM)
       + calcCost(cacheRead, inputPerM * CACHE_READ_MULTIPLIER)
       + calcCost(cacheCreation, inputPerM * CACHE_CREATION_MULTIPLIER);
}

// ─── DB Logger (fire-and-forget) ─────────────────────────────────────────────
let _db: any = null;
let _table: any = null;
async function getDb() {
  if (!_db) {
    try {
      const dbMod = await import("@workspace/db");
      _db = dbMod.db;
      _table = dbMod.aiUsageLogsTable;
    } catch {
      // DB not available — skip logging silently
    }
  }
  return { db: _db, table: _table };
}

interface LogEntry {
  featureName: string;
  tier: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  inputCostUsd: string;
  outputCostUsd: string;
  totalCostUsd: string;
  requestSummary: string | null;
  responseSummary: string | null;
  fullRequest: unknown;
  fullResponse: unknown;
  durationMs: number;
  status: string;
  errorMessage?: string | null;
  metadata?: unknown;
}

function logToDb(entry: LogEntry): void {
  getDb().then(({ db, table }) => {
    if (!db || !table) return;
    db.insert(table).values(entry).catch((err: Error) => {
      console.warn("[ai-usage] log failed:", err.message);
    });
  }).catch(() => {});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function summarizeRequest(params: AnthropicCallParams): string {
  const parts: string[] = [];
  if (typeof params.system === "string") {
    parts.push(params.system.slice(0, 150));
  } else if (Array.isArray(params.system)) {
    parts.push(params.system.map((b) => b.text).join(" ").slice(0, 150));
  }
  if (Array.isArray(params.messages)) {
    const userMsg = params.messages.find((m) => m.role === "user");
    if (userMsg) {
      const text = typeof userMsg.content === "string"
        ? userMsg.content
        : Array.isArray(userMsg.content)
          ? userMsg.content.map((b: any) => b.text || "").join(" ")
          : "";
      parts.push(text.slice(0, 200));
    }
  }
  return parts.join(" | ").slice(0, 400);
}

function summarizeResponse(response: Anthropic.Message): string {
  const textBlocks = response.content.filter((b) => b.type === "text");
  return textBlocks.map((b) => (b as any).text || "").join(" ").slice(0, 500);
}

function serializeRequest(params: AnthropicCallParams): unknown {
  try {
    const { messages, system, model, max_tokens, tools } = params;
    return {
      model,
      max_tokens,
      system: typeof system === "string"
        ? system.slice(0, 2000)
        : Array.isArray(system)
          ? system.map((b) => ({ type: b.type, text: b.text?.slice(0, 2000) }))
          : system,
      tools: tools ? tools.map((t) => (t as any)?.name ?? t) : undefined,
      messages: Array.isArray(messages) ? messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string"
          ? m.content.slice(0, 2000)
          : Array.isArray(m.content)
            ? m.content.map((b: any) => ({
                type: b.type,
                text: b.text ? b.text.slice(0, 2000) : undefined,
                ...(b.type === "image" ? { image: "[image data]" } : {}),
              }))
            : m.content,
      })) : messages,
    };
  } catch {
    return { error: "Failed to serialize request" };
  }
}

function serializeResponse(response: Anthropic.Message): unknown {
  try {
    return {
      id: response.id,
      model: response.model,
      role: response.role,
      stop_reason: response.stop_reason,
      usage: response.usage,
      content: response.content.map((b) => {
        if (b.type === "text") return { type: "text", text: (b as any).text?.slice(0, 3000) };
        if (b.type === "tool_use") return { type: "tool_use", name: (b as any).name, id: (b as any).id };
        return { type: b.type };
      }),
    };
  } catch {
    return { error: "Failed to serialize response" };
  }
}

// ─── Main export: drop-in replacement for anthropic.messages.create ──────────
// Same call signature as before (featureName, params, meta?) but routes
// through the Vercel AI SDK using the configured provider for the tier.
export async function createTrackedMessage(
  featureName: string,
  params: AnthropicCallParams,
  meta?: Record<string, unknown>,
): Promise<Anthropic.Message> {
  const start = Date.now();
  const resolved = await resolveTier(featureName, {
    tierOverride: extractTierOverride(meta),
    providerOverride: extractProviderOverride(meta),
    apiKeyOverride: extractApiKeyOverride(meta),
    baseUrlOverride: extractBaseUrlOverride(meta),
  });
  const aiParams = anthropicToAiSdk(params, { provider: resolved.provider });
  const model = getModel(resolved.provider, resolved.model, resolved.apiKey, {
    baseUrl: resolved.baseUrl,
    extraOptions: resolved.extraOptions,
  });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await generateText({ model, ...(aiParams as any) })) as GenerateTextResult<ToolSet, never>;
    const response = aiSdkToAnthropic(result, resolved.model);
    const durationMs = Date.now() - start;

    const pricing = await getPricingFromCatalog(resolved.model, resolved.provider);
    const usage = response.usage as any;
    const inputCost = computeInputCost(
      {
        input_tokens: usage?.input_tokens ?? 0,
        cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
      },
      pricing.inputPerM,
    );
    const outputCost = calcCost(usage?.output_tokens ?? 0, pricing.outputPerM);

    logToDb({
      featureName,
      tier: resolved.tier,
      provider: resolved.provider,
      model: resolved.model,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
      inputCostUsd: inputCost.toFixed(6),
      outputCostUsd: outputCost.toFixed(6),
      totalCostUsd: (inputCost + outputCost).toFixed(6),
      requestSummary: summarizeRequest(params),
      responseSummary: summarizeResponse(response),
      fullRequest: serializeRequest(params),
      fullResponse: serializeResponse(response),
      durationMs,
      status: "success",
      metadata: meta ?? null,
    });

    return response;
  } catch (err) {
    const durationMs = Date.now() - start;
    logToDb({
      featureName,
      tier: resolved.tier,
      provider: resolved.provider,
      model: resolved.model,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      inputCostUsd: "0",
      outputCostUsd: "0",
      totalCostUsd: "0",
      requestSummary: summarizeRequest(params),
      responseSummary: null,
      fullRequest: serializeRequest(params),
      fullResponse: null,
      durationMs,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      metadata: meta ?? null,
    });
    throw err;
  }
}

// ─── Streaming: drop-in replacement for anthropic.messages.stream ────────────
// Returns a Vercel AI SDK StreamTextResult; caller iterates events and the
// usage log is written once on stream completion (via onFinish callback).
export async function createTrackedStream(
  featureName: string,
  params: AnthropicCallParams,
  meta?: Record<string, unknown>,
): Promise<StreamTextResult<ToolSet, never>> {
  const start = Date.now();
  const resolved = await resolveTier(featureName, {
    tierOverride: extractTierOverride(meta),
    providerOverride: extractProviderOverride(meta),
    apiKeyOverride: extractApiKeyOverride(meta),
    baseUrlOverride: extractBaseUrlOverride(meta),
  });
  const aiParams = anthropicToAiSdk(params, { provider: resolved.provider });
  const model = getModel(resolved.provider, resolved.model, resolved.apiKey, {
    baseUrl: resolved.baseUrl,
    extraOptions: resolved.extraOptions,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = streamText({
    model,
    ...(aiParams as any),
    onFinish: async ({ usage, providerMetadata }: { usage: unknown; providerMetadata?: unknown }) => {
      const durationMs = Date.now() - start;
      const pricing = await getPricingFromCatalog(resolved.model, resolved.provider);
      const aMeta = (((providerMetadata as any) ?? {}).anthropic ?? {}) as Record<string, unknown>;
      const inputTokens = (usage as any)?.inputTokens ?? 0;
      const outputTokens = (usage as any)?.outputTokens ?? 0;
      const cacheRead =
        (aMeta.cacheReadInputTokens as number) ??
        (usage as any)?.cachedInputTokens ?? 0;
      const cacheCreation = (aMeta.cacheCreationInputTokens as number) ?? 0;

      const inputCost = computeInputCost(
        {
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
        },
        pricing.inputPerM,
      );
      const outputCost = calcCost(outputTokens, pricing.outputPerM);

      logToDb({
        featureName,
        tier: resolved.tier,
        provider: resolved.provider,
        model: resolved.model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
        inputCostUsd: inputCost.toFixed(6),
        outputCostUsd: outputCost.toFixed(6),
        totalCostUsd: (inputCost + outputCost).toFixed(6),
        requestSummary: summarizeRequest(params),
        responseSummary: null,
        fullRequest: serializeRequest(params),
        fullResponse: null,
        durationMs,
        status: "success",
        metadata: meta ?? null,
      });
    },
  });

  return stream;
}

// ─── Legacy: kept for backward compat. New code should use createTrackedStream. ──
// Pass actual usage in the params; this just writes a row.
export function logStreamedUsage(
  featureName: string,
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
  durationMs: number,
  requestSummary?: string,
  responseSummary?: string,
  meta?: Record<string, unknown>,
): void {
  const pricing = getPricing(model);
  const inputCost = computeInputCost(usage, pricing.inputPerM);
  const outputCost = calcCost(usage.output_tokens, pricing.outputPerM);

  logToDb({
    featureName,
    tier: null, // legacy path — tier unknown
    provider: "anthropic",
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    inputCostUsd: inputCost.toFixed(6),
    outputCostUsd: outputCost.toFixed(6),
    totalCostUsd: (inputCost + outputCost).toFixed(6),
    requestSummary: requestSummary ?? null,
    responseSummary: responseSummary ?? null,
    fullRequest: null,
    fullResponse: null,
    durationMs,
    status: "success",
    metadata: meta ?? null,
  });
}
