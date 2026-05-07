// Curated SUGGESTIONS for the Settings UI's model combobox. NOT a gate —
// the backend accepts any model id the provider's SDK accepts. The Test
// Connection button in the UI is the real validator.
//
// Refresh quarterly. New providers go here without code changes elsewhere.

export type Provider = "anthropic" | "openai" | "google" | "openrouter";

export const SUPPORTED_PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter"];

export interface ModelSuggestion {
  id: string;
  name: string;
  tier_hint: "basic" | "medium" | "complex";
}

export const MODEL_SUGGESTIONS: Record<Provider, ModelSuggestion[]> = {
  anthropic: [
    { id: "claude-haiku-4-5",            name: "Claude Haiku 4.5",            tier_hint: "basic"   },
    { id: "claude-sonnet-4-6",           name: "Claude Sonnet 4.6",           tier_hint: "medium"  },
    { id: "claude-opus-4-7",             name: "Claude Opus 4.7",             tier_hint: "complex" },
    { id: "claude-3-5-sonnet-20241022",  name: "Claude 3.5 Sonnet (legacy)",  tier_hint: "medium"  },
    { id: "claude-3-haiku-20240307",     name: "Claude 3 Haiku (legacy)",     tier_hint: "basic"   },
  ],
  openai: [
    { id: "gpt-4o-mini",                 name: "GPT-4o mini",                 tier_hint: "basic"   },
    { id: "gpt-4o",                      name: "GPT-4o",                      tier_hint: "medium"  },
    { id: "gpt-4.1",                     name: "GPT-4.1",                     tier_hint: "complex" },
    { id: "gpt-4.1-mini",                name: "GPT-4.1 mini",                tier_hint: "basic"   },
    { id: "o1-mini",                     name: "o1-mini (reasoning)",         tier_hint: "complex" },
    { id: "o1",                          name: "o1 (reasoning)",              tier_hint: "complex" },
  ],
  google: [
    { id: "gemini-1.5-flash",            name: "Gemini 1.5 Flash",            tier_hint: "basic"   },
    { id: "gemini-1.5-pro",              name: "Gemini 1.5 Pro",              tier_hint: "medium"  },
    { id: "gemini-2.0-flash-exp",        name: "Gemini 2.0 Flash (exp)",      tier_hint: "medium"  },
    { id: "gemini-2.5-pro",              name: "Gemini 2.5 Pro",              tier_hint: "complex" },
  ],
  openrouter: [
    { id: "anthropic/claude-haiku-4.5",   name: "Haiku 4.5 via OpenRouter",   tier_hint: "basic"   },
    { id: "anthropic/claude-sonnet-4.6",  name: "Sonnet 4.6 via OpenRouter",  tier_hint: "medium"  },
    { id: "openai/gpt-4o-mini",           name: "GPT-4o mini via OpenRouter", tier_hint: "basic"   },
    { id: "openai/gpt-4o",                name: "GPT-4o via OpenRouter",      tier_hint: "medium"  },
    { id: "google/gemini-flash-1.5",      name: "Gemini Flash via OpenRouter", tier_hint: "basic"  },
    { id: "google/gemini-pro-1.5",        name: "Gemini Pro via OpenRouter",   tier_hint: "medium" },
    { id: "deepseek/deepseek-chat",       name: "DeepSeek Chat",              tier_hint: "medium"  },
    { id: "x-ai/grok-2-1212",             name: "Grok 2",                     tier_hint: "medium"  },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B",         tier_hint: "medium"  },
  ],
};

// Per-1M-token pricing (USD). Used for cost computation in ai_usage_logs.
// Provider-specific. Anthropic + OpenAI rates are first-class; OpenRouter
// rates land at the underlying provider's API but we cannot know the markup
// here, so we under-report by the OpenRouter spread (~10%). Tony can use
// the OpenRouter dashboard for true cost.
//
// Cache pricing rules (Anthropic only): cache_read = input × 0.10,
// cache_creation (5m) = input × 1.25. See usage-logger.ts.
export const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  // Anthropic
  "claude-haiku-4-5":            { inputPerM: 1.00,  outputPerM: 5.00  },
  "claude-haiku-4-5-20251001":   { inputPerM: 1.00,  outputPerM: 5.00  },
  "claude-sonnet-4-5-20250514":  { inputPerM: 3.00,  outputPerM: 15.00 },
  "claude-sonnet-4-5":           { inputPerM: 3.00,  outputPerM: 15.00 },
  "claude-sonnet-4-6":           { inputPerM: 3.00,  outputPerM: 15.00 },
  "claude-opus-4-5":             { inputPerM: 15.00, outputPerM: 75.00 },
  "claude-opus-4-7":             { inputPerM: 15.00, outputPerM: 75.00 },
  "claude-3-5-sonnet-20241022":  { inputPerM: 3.00,  outputPerM: 15.00 },
  "claude-3-haiku-20240307":     { inputPerM: 0.25,  outputPerM: 1.25  },
  // OpenAI
  "gpt-4o-mini":                 { inputPerM: 0.15,  outputPerM: 0.60  },
  "gpt-4o":                      { inputPerM: 2.50,  outputPerM: 10.00 },
  "gpt-4.1":                     { inputPerM: 2.00,  outputPerM: 8.00  },
  "gpt-4.1-mini":                { inputPerM: 0.40,  outputPerM: 1.60  },
  "gpt-4.1-nano":                { inputPerM: 0.10,  outputPerM: 0.40  },
  "o1":                          { inputPerM: 15.00, outputPerM: 60.00 },
  "o1-mini":                     { inputPerM: 1.10,  outputPerM: 4.40  },
  // Google
  "gemini-1.5-flash":            { inputPerM: 0.075, outputPerM: 0.30  },
  "gemini-1.5-pro":              { inputPerM: 1.25,  outputPerM: 5.00  },
  "gemini-2.0-flash-exp":        { inputPerM: 0.10,  outputPerM: 0.40  },
  "gemini-2.5-pro":              { inputPerM: 1.25,  outputPerM: 10.00 },
};

/**
 * Look up pricing for a model id. Returns zero rates for unknown models so
 * cost calc continues; logs a warning so we know to add it to the table.
 */
export function getPricing(model: string): { inputPerM: number; outputPerM: number } {
  const p = MODEL_PRICING[model];
  if (p) return p;
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[model-catalog] unknown model='${model}' — cost will log as 0. Add to MODEL_PRICING.`);
  }
  return { inputPerM: 0, outputPerM: 0 };
}

// ─── Async DB-backed pricing (preferred) ────────────────────────────────────
// In-process TTL cache keyed by `${provider}:${model}` (or just model when
// provider isn't known). Hit ratio is high — usage-logger calls this on
// every AI request and the catalog changes only on Refresh Models.
const CATALOG_TTL_MS = 5 * 60 * 1000;
const _catalogCache = new Map<string, { value: { inputPerM: number; outputPerM: number }; expiresAt: number }>();

let _catalogDb: any = null;
let _catalogTable: any = null;
let _catalogEq: any = null;
let _catalogAnd: any = null;
async function getCatalogDb(): Promise<{ db: any; table: any; eq: any; and: any } | null> {
  if (_catalogDb !== null) {
    return _catalogDb === false ? null : { db: _catalogDb, table: _catalogTable, eq: _catalogEq, and: _catalogAnd };
  }
  try {
    const dbMod = await import("@workspace/db");
    _catalogDb = dbMod.db;
    _catalogTable = dbMod.modelCatalogTable;
    const drizzleMod = await import("drizzle-orm");
    _catalogEq = drizzleMod.eq;
    _catalogAnd = drizzleMod.and;
    return { db: _catalogDb, table: _catalogTable, eq: _catalogEq, and: _catalogAnd };
  } catch {
    _catalogDb = false;
    return null;
  }
}

/**
 * Async pricing lookup: in-process cache (5 min) → model_catalog row →
 * MODEL_PRICING constant → {0, 0} with warn. Provider is optional but
 * narrows the lookup when callers know it (avoids picking the wrong row
 * for a model id that exists under multiple providers, e.g. OpenRouter
 * proxying anthropic/claude-haiku-4.5).
 */
export async function getPricingFromCatalog(
  model: string,
  provider?: string,
): Promise<{ inputPerM: number; outputPerM: number }> {
  const cacheKey = `${provider ?? "?"}:${model}`;
  const cached = _catalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value: { inputPerM: number; outputPerM: number } | null = null;
  const ctx = await getCatalogDb();
  if (ctx) {
    try {
      const where = provider
        ? ctx.and(ctx.eq(ctx.table.provider, provider), ctx.eq(ctx.table.modelId, model))
        : ctx.eq(ctx.table.modelId, model);
      const rows = await ctx.db.select().from(ctx.table).where(where).limit(1);
      const row = rows[0];
      if (row) {
        value = {
          inputPerM: parseFloat(row.inputPerM),
          outputPerM: parseFloat(row.outputPerM),
        };
      }
    } catch {
      // DB unavailable — fall through to in-memory constant.
    }
  }
  if (!value) {
    const fallback = MODEL_PRICING[model];
    if (fallback) {
      value = fallback;
    } else {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[model-catalog] unknown model='${model}' (provider='${provider ?? "?"}') — cost will log as 0.`);
      }
      value = { inputPerM: 0, outputPerM: 0 };
    }
  }
  _catalogCache.set(cacheKey, { value, expiresAt: Date.now() + CATALOG_TTL_MS });
  return value;
}

/** Drop the in-process pricing cache. Called by sync-models so the next
 *  cost calc picks up the freshly-synced rates. */
export function invalidateCatalogCache(): void {
  _catalogCache.clear();
}
