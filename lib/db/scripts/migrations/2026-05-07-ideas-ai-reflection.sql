-- Bug 11 — Persist AI Reflection on ideas.
-- The `ideas.ai_reflection` column was added previously as TEXT (used to store
-- the JSON-stringified classification result). This migration is intentionally
-- idempotent — it just guarantees the column is present in environments that
-- somehow missed the original drizzle push. Schema continues to use TEXT (not
-- JSONB) because the codebase already round-trips through JSON.stringify /
-- JSON.parse and switching the storage type would break in-flight rows.

ALTER TABLE ideas ADD COLUMN IF NOT EXISTS ai_reflection text;
