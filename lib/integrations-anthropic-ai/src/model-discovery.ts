// Sync per-provider model lists into the model_catalog table.
//
// Each provider's /v1/models endpoint behaves differently:
//   - Anthropic / OpenAI / Google: return only model IDs, no pricing. We
//     fall back to the curated MODEL_PRICING constant; unknown IDs are
//     skipped (we don't insert $0 rows that would silently zero out cost).
//   - OpenRouter is the only provider returning live pricing in /v1/models
//     (per-token in their `pricing.prompt`/`pricing.completion`). We persist
//     directly, multiplied to per-M.
//
// All inserts use ON CONFLICT (provider, model_id) DO UPDATE so reruns are idempotent.

import { MODEL_PRICING, type Provider } from "./model-catalog";
import { decryptKey } from "./secrets";

export interface SyncResult {
  added: number;
  updated: number;
  errors: string[];
}

// Lazy-load db to keep this package free of a hard drizzle dep (matches the
// pattern in tier-resolver.ts / usage-logger.ts).
let _db: any = null;
let _modelCatalog: any = null;
let _aiProviderSettings: any = null;
let _eq: any = null;
async function getDb(): Promise<{ db: any; modelCatalog: any; aiProviderSettings: any; eq: any }> {
  if (!_db) {
    const dbMod = await import("@workspace/db");
    _db = dbMod.db;
    _modelCatalog = dbMod.modelCatalogTable;
    _aiProviderSettings = dbMod.aiProviderSettingsTable;
    const drizzleMod = await import("drizzle-orm");
    _eq = drizzleMod.eq;
  }
  return { db: _db, modelCatalog: _modelCatalog, aiProviderSettings: _aiProviderSettings, eq: _eq };
}

function envFallbackKey(provider: Provider): string {
  const map: Record<Provider, string> = {
    anthropic: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? "",
    openai: process.env.OPENAI_API_KEY ?? "",
    google: process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
    openrouter: process.env.OPENROUTER_API_KEY ?? "",
  };
  return map[provider];
}

async function getApiKey(provider: Provider): Promise<string> {
  // Pull from any tier configured for this provider; otherwise env var.
  const { db, aiProviderSettings } = await getDb();
  const rows = await db.select().from(aiProviderSettings);
  const match = (rows as Array<{
    provider: string;
    apiKeyCipher: Buffer | null;
    apiKeyIv: Buffer | null;
    apiKeyTag: Buffer | null;
  }>).find((r) => r.provider === provider && r.apiKeyCipher && r.apiKeyIv && r.apiKeyTag);
  if (match?.apiKeyCipher && match.apiKeyIv && match.apiKeyTag) {
    try {
      return decryptKey({ cipher: match.apiKeyCipher, iv: match.apiKeyIv, tag: match.apiKeyTag });
    } catch {
      // fall through to env
    }
  }
  return envFallbackKey(provider);
}

interface CatalogRow {
  provider: Provider;
  modelId: string;
  inputPerM: number;
  outputPerM: number;
  displayName: string | null;
}

async function upsertRows(rows: CatalogRow[]): Promise<{ added: number; updated: number }> {
  if (rows.length === 0) return { added: 0, updated: 0 };
  const { db, modelCatalog } = await getDb();
  const drizzleMod = await import("drizzle-orm");
  const sql = drizzleMod.sql;

  let added = 0;
  let updated = 0;

  for (const r of rows) {
    const result = await db
      .insert(modelCatalog)
      .values({
        provider: r.provider,
        modelId: r.modelId,
        inputPerM: String(r.inputPerM),
        outputPerM: String(r.outputPerM),
        displayName: r.displayName,
      })
      .onConflictDoUpdate({
        target: [modelCatalog.provider, modelCatalog.modelId],
        set: {
          inputPerM: String(r.inputPerM),
          outputPerM: String(r.outputPerM),
          displayName: r.displayName,
          lastSyncedAt: sql`NOW()`,
        },
      })
      .returning({
        id: modelCatalog.id,
        lastSyncedAt: modelCatalog.lastSyncedAt,
      });

    // Heuristic: if returning row was created within the last second, treat
    // as "added"; otherwise "updated". Postgres doesn't expose xmax via
    // drizzle's returning clause portably.
    const r0 = result[0];
    if (r0 && Date.now() - new Date(r0.lastSyncedAt).getTime() < 1500) {
      // Could be either insert or update — disambiguate by counting rows
      // pre-existing. Cheap enough: another count query would double traffic,
      // so we approximate. The UI only displays the sum anyway.
      added++;
    } else {
      updated++;
    }
  }

  return { added, updated };
}

// ─── Anthropic ──────────────────────────────────────────────────────────────
async function syncAnthropic(): Promise<SyncResult> {
  const errors: string[] = [];
  const apiKey = await getApiKey("anthropic");
  if (!apiKey) return { added: 0, updated: 0, errors: ["No API key for anthropic (DB nor env)."] };

  const resp = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { added: 0, updated: 0, errors: [`Anthropic /v1/models ${resp.status}: ${text.slice(0, 200)}`] };
  }
  const json = (await resp.json()) as { data?: Array<{ id: string; display_name?: string }> };
  const list = json.data ?? [];

  const rows: CatalogRow[] = [];
  for (const m of list) {
    const p = MODEL_PRICING[m.id];
    if (!p) {
      console.warn(`[model-discovery] anthropic '${m.id}' not in MODEL_PRICING — skipping (would log $0).`);
      continue;
    }
    rows.push({
      provider: "anthropic",
      modelId: m.id,
      inputPerM: p.inputPerM,
      outputPerM: p.outputPerM,
      displayName: m.display_name ?? null,
    });
  }
  const counts = await upsertRows(rows);
  return { ...counts, errors };
}

// ─── OpenAI ─────────────────────────────────────────────────────────────────
async function syncOpenAI(): Promise<SyncResult> {
  const errors: string[] = [];
  const apiKey = await getApiKey("openai");
  if (!apiKey) return { added: 0, updated: 0, errors: ["No API key for openai (DB nor env)."] };

  const resp = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { added: 0, updated: 0, errors: [`OpenAI /v1/models ${resp.status}: ${text.slice(0, 200)}`] };
  }
  const json = (await resp.json()) as { data?: Array<{ id: string }> };
  const list = json.data ?? [];

  const rows: CatalogRow[] = [];
  for (const m of list) {
    const p = MODEL_PRICING[m.id];
    if (!p) {
      console.warn(`[model-discovery] openai '${m.id}' not in MODEL_PRICING — skipping (would log $0).`);
      continue;
    }
    rows.push({
      provider: "openai",
      modelId: m.id,
      inputPerM: p.inputPerM,
      outputPerM: p.outputPerM,
      displayName: null,
    });
  }
  const counts = await upsertRows(rows);
  return { ...counts, errors };
}

// ─── Google ─────────────────────────────────────────────────────────────────
async function syncGoogle(): Promise<SyncResult> {
  const errors: string[] = [];
  const apiKey = await getApiKey("google");
  if (!apiKey) return { added: 0, updated: 0, errors: ["No API key for google (DB nor env)."] };

  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { added: 0, updated: 0, errors: [`Google /v1beta/models ${resp.status}: ${text.slice(0, 200)}`] };
  }
  const json = (await resp.json()) as { models?: Array<{ name: string; displayName?: string }> };
  const list = json.models ?? [];

  const rows: CatalogRow[] = [];
  for (const m of list) {
    // Google returns "models/gemini-1.5-pro" — strip the prefix to get the id callers use.
    const id = m.name.replace(/^models\//, "");
    const p = MODEL_PRICING[id];
    if (!p) {
      console.warn(`[model-discovery] google '${id}' not in MODEL_PRICING — skipping (would log $0).`);
      continue;
    }
    rows.push({
      provider: "google",
      modelId: id,
      inputPerM: p.inputPerM,
      outputPerM: p.outputPerM,
      displayName: m.displayName ?? null,
    });
  }
  const counts = await upsertRows(rows);
  return { ...counts, errors };
}

// ─── OpenRouter ─────────────────────────────────────────────────────────────
// OpenRouter is the only provider returning live pricing in /v1/models, so
// we persist its rates directly (per-token → per-M).
async function syncOpenRouter(): Promise<SyncResult> {
  const errors: string[] = [];
  const apiKey = await getApiKey("openrouter");
  // OpenRouter /models is public, but pass auth if we have it (avoids rate limits).
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const resp = await fetch("https://openrouter.ai/api/v1/models", { headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { added: 0, updated: 0, errors: [`OpenRouter /v1/models ${resp.status}: ${text.slice(0, 200)}`] };
  }
  const json = (await resp.json()) as {
    data?: Array<{
      id: string;
      name?: string;
      pricing?: { prompt?: string; completion?: string };
    }>;
  };
  const list = json.data ?? [];

  const rows: CatalogRow[] = [];
  for (const m of list) {
    const promptStr = m.pricing?.prompt;
    const completionStr = m.pricing?.completion;
    if (!promptStr || !completionStr) continue;
    const promptPerToken = parseFloat(promptStr);
    const completionPerToken = parseFloat(completionStr);
    if (!Number.isFinite(promptPerToken) || !Number.isFinite(completionPerToken)) continue;
    rows.push({
      provider: "openrouter",
      modelId: m.id,
      inputPerM: promptPerToken * 1_000_000,
      outputPerM: completionPerToken * 1_000_000,
      displayName: m.name ?? null,
    });
  }
  const counts = await upsertRows(rows);
  return { ...counts, errors };
}

// ─── Public API ─────────────────────────────────────────────────────────────
export async function syncProvider(provider: Provider): Promise<SyncResult> {
  switch (provider) {
    case "anthropic": return syncAnthropic();
    case "openai": return syncOpenAI();
    case "google": return syncGoogle();
    case "openrouter": return syncOpenRouter();
    default: {
      const exhaustive: never = provider;
      return { added: 0, updated: 0, errors: [`Unknown provider: ${exhaustive}`] };
    }
  }
}

export async function syncAllProviders(): Promise<Record<Provider, SyncResult>> {
  const providers: Provider[] = ["anthropic", "openai", "google", "openrouter"];
  const out: Partial<Record<Provider, SyncResult>> = {};
  for (const p of providers) {
    try {
      out[p] = await syncProvider(p);
    } catch (err) {
      out[p] = { added: 0, updated: 0, errors: [err instanceof Error ? err.message : String(err)] };
    }
  }
  return out as Record<Provider, SyncResult>;
}
