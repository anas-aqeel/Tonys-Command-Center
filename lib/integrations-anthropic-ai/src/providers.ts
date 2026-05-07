// Provider factory — given (provider, apiKey, opts) returns a Vercel AI SDK
// LanguageModel that the wrapper can pass to generateText/streamText.
//
// The four supported providers (Anthropic, OpenAI, Google, OpenRouter) all
// expose `createX({ apiKey, baseURL? })` returning a callable provider; the
// callable resolves a model id ('claude-...', 'gpt-...', 'gemini-...') to a
// LanguageModel instance.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, type LanguageModel } from "ai";
import type { Provider } from "./model-catalog";

export interface ProviderOpts {
  baseUrl?: string;
  /** Provider-specific. Today we don't need any structured fields here. */
  extraOptions?: Record<string, unknown>;
}

/**
 * Build a Vercel AI SDK LanguageModel for the given (provider, model, key).
 * The caller passes this directly to `generateText({ model, ... })`.
 */
export function getModel(
  provider: Provider,
  modelId: string,
  apiKey: string,
  opts: ProviderOpts = {},
): LanguageModel {
  switch (provider) {
    case "anthropic": {
      const factory = createAnthropic({
        apiKey,
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      });
      return factory(modelId);
    }
    case "openai": {
      const factory = createOpenAI({
        apiKey,
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      });
      return factory(modelId);
    }
    case "google": {
      const factory = createGoogleGenerativeAI({
        apiKey,
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      });
      return factory(modelId);
    }
    case "openrouter": {
      const factory = createOpenRouter({
        apiKey,
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      });
      // OpenRouter's provider returns a chat-model factory at .chat()
      // but the bare callable shape works too in v3.
      return factory.chat(modelId);
    }
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown AI provider: ${exhaustive}`);
    }
  }
}

export interface TestProviderResult {
  ok: boolean;
  durationMs: number;
  preview: string;
  usage: unknown;
}

/**
 * Pre-flight: does the API key prefix match the chosen provider? Catches
 * the easy mistake of pasting an Anthropic key (sk-ant-…) into the OpenAI
 * field — without this, the user gets an OpenAI-shaped "Incorrect API key"
 * which falsely implicates the key.
 *
 * OpenRouter accepts varied prefixes (sk-or-v1-…, plain UUIDs through some
 * proxies) so we skip the check for it.
 */
function keyPrefixMismatch(provider: Provider, apiKey: string): string | null {
  const k = apiKey.trim();
  if (!k) return null; // empty handled by SDK
  switch (provider) {
    case "anthropic":
      if (!k.startsWith("sk-ant-")) {
        return `API key prefix doesn't match provider anthropic. Check key or provider selection.`;
      }
      return null;
    case "openai":
      // OpenAI keys start with sk-, but sk-ant- is Anthropic's and we want to flag it.
      if (!k.startsWith("sk-") || k.startsWith("sk-ant-")) {
        return `API key prefix doesn't match provider openai. Check key or provider selection.`;
      }
      return null;
    case "google":
      if (!k.startsWith("AIza")) {
        return `API key prefix doesn't match provider google. Check key or provider selection.`;
      }
      return null;
    case "openrouter":
      return null; // varied prefixes — pass through
    default: {
      const exhaustive: never = provider;
      return `Unknown provider: ${exhaustive}`;
    }
  }
}

/**
 * Run a tiny generation against the given (provider, model, key) to verify
 * connectivity + authentication + that the model id is valid. Surfaces the
 * provider's error message verbatim so the UI can show "model not found",
 * "401 invalid key", etc. directly.
 *
 * Throws synchronously with a "prefix doesn't match provider" message when
 * the key shape is obviously wrong, so the user fixes the key/provider
 * pairing before we ever hit the SDK (which would surface a misleading
 * provider-shaped 401).
 */
export async function testProvider(
  provider: Provider,
  modelId: string,
  apiKey: string,
  opts: ProviderOpts = {},
): Promise<TestProviderResult> {
  const mismatch = keyPrefixMismatch(provider, apiKey);
  if (mismatch) throw new Error(mismatch);

  const model = getModel(provider, modelId, apiKey, opts);
  const t0 = Date.now();
  const result = await generateText({
    model,
    // OpenAI rejects values < 16; other providers accept low values fine.
    maxOutputTokens: 32,
    messages: [{ role: "user", content: 'Reply with the single word: "ok".' }],
  });
  return {
    ok: true,
    durationMs: Date.now() - t0,
    preview: (result.text ?? "").slice(0, 60),
    usage: result.usage,
  };
}
