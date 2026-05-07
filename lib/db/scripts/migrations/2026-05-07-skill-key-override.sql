-- Per-skill API key override columns. Skill-level always wins over tier-level
-- when set. See lib/integrations-anthropic-ai/src/tier-resolver.ts (apiKeyOverride
-- / baseUrlOverride). Idempotent: ADD COLUMN IF NOT EXISTS.
--
-- api_key_cipher stores a single colon-packed base64 blob (iv:tag:cipher)
-- produced by encryptKeyToString() — see lib/integrations-anthropic-ai/src/secrets.ts.
-- That keeps the schema additive (just one text column) instead of bringing
-- the bytea cipher/iv/tag triple from ai_provider_settings.

ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS api_key_cipher text;
ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS base_url text;
