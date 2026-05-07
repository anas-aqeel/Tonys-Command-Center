// Public API of @workspace/integrations-anthropic-ai.
// Despite the package name, this layer is multi-provider: every call below
// resolves provider+model+key from ai_provider_settings via the tier of its
// featureName. Anthropic remains the default, but settings can switch a tier
// to OpenAI / Google / OpenRouter without touching call sites.

// Raw Anthropic SDK instance — DEPRECATED. Kept only so existing type usages
// (Parameters<typeof anthropic.messages.create>[0]) keep typechecking. New
// code should use createTrackedMessage / createTrackedStream below.
export { anthropic } from "./client";

// Main wrapper exports.
export { createTrackedMessage, createTrackedStream, logStreamedUsage } from "./usage-logger";

// Types + helpers for callers that want to peek at provider/tier resolution.
export { tierFor, type Tier } from "./feature-tiers";
export { resolveTier, invalidateTierCache } from "./tier-resolver";
export type { Provider, ModelSuggestion } from "./model-catalog";
export { SUPPORTED_PROVIDERS, MODEL_SUGGESTIONS, MODEL_PRICING, getPricing, getPricingFromCatalog, invalidateCatalogCache } from "./model-catalog";
export { encryptKey, decryptKey, encryptKeyToString, decryptKeyFromString, isEncryptionConfigured, type EncryptedSecret } from "./secrets";
export { getModel, testProvider, type TestProviderResult } from "./providers";
export { syncProvider, syncAllProviders, type SyncResult } from "./model-discovery";
