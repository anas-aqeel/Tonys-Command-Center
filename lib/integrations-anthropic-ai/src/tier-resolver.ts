// Resolves a featureName to its (tier, provider, model, apiKey) at call time.
// Hot path: hits an in-memory TTL cache so each invocation costs ~0.05 ms.
// PATCHing settings invalidates the cache for the affected tier (see
// invalidateTierCache called from the settings route).

import { tierFor, type Tier } from "./feature-tiers";
import { decryptKey } from "./secrets";
import type { Provider } from "./model-catalog";

export interface ResolvedTier {
  tier: Tier;
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  extraOptions: Record<string, unknown>;
}

const TTL_MS = 30_000;
type CacheEntry = ResolvedTier & { expiresAt: number };
const cache = new Map<Tier, CacheEntry>();

// Lazy-load db + drizzle helper from @workspace/db so this package doesn't
// list drizzle-orm directly (matches the logToDb pattern in usage-logger.ts).
let _db: any = null;
let _table: any = null;
let _eq: any = null;
async function getDb(): Promise<{ db: any; table: any; eq: any }> {
  if (!_db) {
    const dbMod = await import("@workspace/db");
    _db = dbMod.db;
    _table = dbMod.aiProviderSettingsTable;
    const drizzleMod = await import("drizzle-orm");
    _eq = drizzleMod.eq;
  }
  return { db: _db, table: _table, eq: _eq };
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

export interface ResolveTierOpts {
  /**
   * Explicit tier (e.g. read from agent_skills.tier). When set, the
   * featureName-based lookup is skipped — caller knows better than tierFor().
   * Used by the agent runtime so per-skill tier columns are authoritative.
   */
  tierOverride?: Tier;
}

/**
 * Resolve the active settings for the tier of `featureName`. Throws if no
 * row exists for the tier or no API key can be sourced (DB nor env).
 *
 * If `opts.tierOverride` is provided, it takes precedence over tierFor() —
 * lets the agent runtime honor agent_skills.tier instead of falling through
 * the agent_* default in the feature-tier map.
 */
export async function resolveTier(
  featureName: string,
  opts: ResolveTierOpts = {},
): Promise<ResolvedTier> {
  const tier = opts.tierOverride ?? tierFor(featureName);
  const cached = cache.get(tier);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const { db, table, eq } = await getDb();
  const rows = await db.select().from(table).where(eq(table.tier, tier));
  const row = rows[0];
  if (!row) throw new Error(`[tier-resolver] No ai_provider_settings row for tier='${tier}'`);

  const provider = row.provider as Provider;
  let apiKey = "";

  if (row.apiKeyCipher && row.apiKeyIv && row.apiKeyTag) {
    apiKey = decryptKey({
      cipher: row.apiKeyCipher,
      iv: row.apiKeyIv,
      tag: row.apiKeyTag,
    });
  } else {
    apiKey = envFallbackKey(provider);
  }

  if (!apiKey) {
    throw new Error(
      `[tier-resolver] No API key for tier='${tier}' provider='${provider}'. ` +
      `Configure in Settings → Models or set the env var.`,
    );
  }

  const resolved: ResolvedTier = {
    tier,
    provider,
    model: row.model,
    apiKey,
    baseUrl: row.baseUrl ?? undefined,
    extraOptions: (row.extraOptions ?? {}) as Record<string, unknown>,
  };

  cache.set(tier, { ...resolved, expiresAt: Date.now() + TTL_MS });
  return resolved;
}

/**
 * Drop cached settings for one tier (or all). Called by the settings PATCH
 * endpoint so a config change is reflected immediately, not after the 30 s TTL.
 */
export function invalidateTierCache(tier?: Tier): void {
  if (tier) cache.delete(tier);
  else cache.clear();
}
