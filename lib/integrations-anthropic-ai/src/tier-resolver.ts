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

const VALID_PROVIDERS: ReadonlySet<Provider> = new Set([
  "anthropic",
  "openai",
  "google",
  "openrouter",
]);

export interface ResolveTierOpts {
  /**
   * Explicit tier (e.g. read from agent_skills.tier). When set, the
   * featureName-based lookup is skipped — caller knows better than tierFor().
   * Used by the agent runtime so per-skill tier columns are authoritative.
   */
  tierOverride?: Tier;
  /**
   * Explicit provider (e.g. read from agent_skills.provider_override). When set
   * AND it's a recognised provider, the resolver uses that provider for the
   * outgoing call. Invalid values are silently ignored.
   *
   * Resolution priority for the API key paired with this provider:
   *   1. apiKeyOverride (skill's own decrypted key) — always wins when set
   *   2. ai_provider_settings row whose provider matches providerOverride
   *   3. tier's default row's key
   */
  providerOverride?: Provider | string | null;
  /**
   * Already-decrypted API key from agent_skills.api_key_cipher. When set,
   * this is used directly with `providerOverride` (or with the tier's provider
   * if no providerOverride). Skill-level config is first-class — we don't
   * reach into another tier's row when the skill carries its own key.
   */
  apiKeyOverride?: string | null;
  /**
   * Optional base URL paired with apiKeyOverride (agent_skills.base_url).
   * Used for self-hosted OpenRouter proxies / Vertex regions.
   */
  baseUrlOverride?: string | null;
  /**
   * Optional model override (e.g. agent_skills.model_override). Currently the
   * runtime overrides `params.model` directly so this is informational, but
   * accepted here for symmetry with the other skill-level fields.
   */
  modelOverride?: string | null;
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

  // Validate the provider override up front. An invalid value is ignored —
  // we never crash a call because the DB column is unexpected text.
  const rawProviderOverride = opts.providerOverride;
  const providerOverride: Provider | undefined =
    typeof rawProviderOverride === "string" && VALID_PROVIDERS.has(rawProviderOverride as Provider)
      ? (rawProviderOverride as Provider)
      : undefined;

  const apiKeyOverride =
    typeof opts.apiKeyOverride === "string" && opts.apiKeyOverride.length > 0
      ? opts.apiKeyOverride
      : null;
  const baseUrlOverride =
    typeof opts.baseUrlOverride === "string" && opts.baseUrlOverride.length > 0
      ? opts.baseUrlOverride
      : null;

  // Cache is keyed by tier only — skip it whenever any skill-level override is
  // in play (provider, key, or base URL), since those bypass the tier-default row.
  const skipCache = Boolean(providerOverride || apiKeyOverride || baseUrlOverride);
  if (!skipCache) {
    const cached = cache.get(tier);
    if (cached && cached.expiresAt > Date.now()) return cached;
  }

  const { db, table, eq } = await getDb();

  // Pull the row matching the tier. Used as the base for everything below.
  const rows = await db.select().from(table).where(eq(table.tier, tier));
  let row = rows[0];
  if (!row) throw new Error(`[tier-resolver] No ai_provider_settings row for tier='${tier}'`);

  // ── Resolve provider + (when needed) the row whose key we'll use ──────────
  // Skill-level rules:
  //   - apiKeyOverride present → use IT directly + the providerOverride (or
  //     tier-default provider if none). Do NOT re-read another tier row.
  //   - apiKeyOverride absent + providerOverride differs from tier provider →
  //     re-read ai_provider_settings filtered by that provider so we inherit
  //     its saved key (legacy behavior — Wave 1 cycle 2).
  //   - neither → tier-default row.
  if (apiKeyOverride) {
    if (providerOverride && row.provider !== providerOverride) {
      // We still want the model field to come from the provider's saved row
      // when one exists (so an empty model_override doesn't pin to the tier
      // default's model id which is for a different provider). If no row
      // exists for that provider, fall through and let the caller's
      // params.model carry the right value.
      const overrideRows = await db
        .select()
        .from(table)
        .where(eq(table.provider, providerOverride));
      if (overrideRows[0]) row = overrideRows[0];
      else {
        // Synthesize: keep the tier row for shape but stamp provider so the
        // ResolvedTier emitted below carries the requested provider.
        row = { ...row, provider: providerOverride };
      }
    }
  } else if (providerOverride && row.provider !== providerOverride) {
    const overrideRows = await db
      .select()
      .from(table)
      .where(eq(table.provider, providerOverride));
    const overrideRow = overrideRows[0];
    if (!overrideRow) {
      throw new Error(
        `[tier-resolver] No ai_provider_settings row for provider='${providerOverride}'. ` +
        `Configure that provider in Settings → Models, or set a per-skill API key.`,
      );
    }
    row = overrideRow;
  }

  const provider = row.provider as Provider;
  let apiKey = "";

  if (apiKeyOverride) {
    apiKey = apiKeyOverride;
  } else if (row.apiKeyCipher && row.apiKeyIv && row.apiKeyTag) {
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
      `Configure in Settings → Models, set a per-skill API key, or set the env var.`,
    );
  }

  // baseUrl: skill-level wins over the tier row's baseUrl.
  const baseUrl = baseUrlOverride ?? row.baseUrl ?? undefined;

  const resolved: ResolvedTier = {
    tier,
    provider,
    model: row.model,
    apiKey,
    baseUrl,
    extraOptions: (row.extraOptions ?? {}) as Record<string, unknown>,
  };

  // Only cache the tier-default path. Skill-overridden results bypass the cache
  // so a later call without overrides doesn't see the wrong provider/key.
  if (!skipCache) {
    cache.set(tier, { ...resolved, expiresAt: Date.now() + TTL_MS });
  }
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
