-- Model catalog: per-provider list of model IDs + USD pricing per 1M tokens.
-- Powers cost calc in ai_usage_logs and the Refresh Models button in the
-- model-settings UI. See lib/integrations-anthropic-ai/src/model-discovery.ts.
--
-- Plus: agent_skills.provider_override so a per-skill model override can be
-- pinned to a specific provider (otherwise the override resolves against
-- whatever provider the tier currently points to).

CREATE TABLE IF NOT EXISTS model_catalog (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL CHECK (provider IN ('anthropic','openai','google','openrouter')),
  model_id        text NOT NULL,
  input_per_m     numeric(10, 4) NOT NULL,
  output_per_m    numeric(10, 4) NOT NULL,
  display_name    text,
  last_synced_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS model_catalog_provider_model_uniq
  ON model_catalog (provider, model_id);

ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS provider_override text;
