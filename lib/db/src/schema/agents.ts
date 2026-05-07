import { pgTable, uuid, text, integer, jsonb, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// 5.1 Knowledge store — replaces filesystem .md files at runtime.
// Seeded from ai-outputs/ai-architecture/**/*.md. Coach can only edit kind='memory'.
export const agentMemoryEntriesTable = pgTable("agent_memory_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  agent: text("agent").notNull(),                    // 'email' | 'tasks' | ... | 'coach' | '_shared'
  kind: text("kind").notNull(),                      // 'soul' | 'user' | 'identity' | 'agents' | 'tools' | 'skill' | 'memory'
  sectionName: text("section_name").notNull(),       // e.g. 'tone-preferences', 'reply-draft'
  content: text("content").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),                     // 'seed' | 'tony' | 'coach' | 'developer'
}, (t) => [
  uniqueIndex("agent_memory_entries_unique_idx").on(t.agent, t.kind, t.sectionName),
  index("agent_memory_entries_agent_idx").on(t.agent),
]);

// 5.1b Skill registry — frontmatter parsed from SKILLS/<name>.md files.
// Drives runtime skill lookup: model, max_tokens, declared tools, declared memory_sections.
export const agentSkillsTable = pgTable("agent_skills", {
  id: uuid("id").defaultRandom().primaryKey(),
  agent: text("agent").notNull(),
  skillName: text("skill_name").notNull(),           // e.g. 'reply.draft', 'classify'
  // tier — primary signal under multi-provider settings (basic/medium/complex).
  // Resolves provider+model via ai_provider_settings at call time.
  // model + modelOverride below remain for backward compat / per-skill override.
  tier: text("tier"),                                // 'basic' | 'medium' | 'complex'
  model: text("model").notNull(),                    // legacy: e.g. 'claude-haiku-4-5'
  maxTokens: integer("max_tokens").notNull().default(1024),
  tools: jsonb("tools").notNull().default(sql`'[]'::jsonb`),                   // string[] of tool names
  memorySections: jsonb("memory_sections").notNull().default(sql`'[]'::jsonb`), // string[] of section_name
  autoExamples: jsonb("auto_examples").notNull().default(sql`'false'::jsonb`),  // boolean — Coach may auto-append examples
  modelOverride: text("model_override"),             // optional dashboard-set override (still wins over tier)
  providerOverride: text("provider_override"),       // optional dashboard-set provider pin for the override (anthropic|openai|google|openrouter)
  // First-class per-skill API key override. When set, runtime ignores the matching
  // tier row's key and uses this skill's own key directly. Stored as a single
  // text blob in `iv_b64:tag_b64:cipher_b64` form (encrypted via AES-256-GCM
  // with the same SETTINGS_ENCRYPTION_KEY master key as ai_provider_settings).
  // Null = inherit the tier provider's saved key (legacy behavior).
  apiKeyCipher: text("api_key_cipher"),
  // Optional base URL override (e.g. self-hosted OpenRouter proxy / Vertex region).
  baseUrl: text("base_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("agent_skills_unique_idx").on(t.agent, t.skillName),
  index("agent_skills_agent_idx").on(t.agent),
]);

// 5.1d Model catalog — per-provider list of model IDs + USD pricing per 1M
// tokens. Synced on demand from each provider's /v1/models endpoint (see
// model-discovery.ts). Cost calc reads this; the in-memory MODEL_PRICING
// constant in model-catalog.ts is the curated fallback for providers that
// don't return live pricing in their list-models response.
export const modelCatalogTable = pgTable("model_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),                                    // 'anthropic' | 'openai' | 'google' | 'openrouter'
  modelId: text("model_id").notNull(),
  inputPerM: numeric("input_per_m", { precision: 10, scale: 4 }).notNull(),
  outputPerM: numeric("output_per_m", { precision: 10, scale: 4 }).notNull(),
  displayName: text("display_name"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("model_catalog_provider_model_uniq").on(t.provider, t.modelId),
]);

// 5.1c Tool registry — function-tool definitions parsed from TOOLS.md per agent.
// Bound at runtime: skill declares tool names; runtime resolves to handlers.
export const agentToolsTable = pgTable("agent_tools", {
  id: uuid("id").defaultRandom().primaryKey(),
  toolName: text("tool_name").notNull().unique(),    // e.g. 'get_email_thread'
  agent: text("agent"),                              // owning agent (null = shared)
  description: text("description"),
  inputSchema: jsonb("input_schema").notNull(),      // JSONSchema for Anthropic tool spec
  handlerPath: text("handler_path").notNull(),       // file path relative to artifacts/api-server/src/agents/tools/
  isNative: integer("is_native").notNull().default(0), // 1 = Anthropic native tool (e.g. web_search)
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("agent_tools_agent_idx").on(t.agent),
]);

// 5.2 Captured feedback queue — all 👍/👎 / overrides / reorders / corrections land here.
export const agentFeedbackTable = pgTable("agent_feedback", {
  id: uuid("id").defaultRandom().primaryKey(),
  agent: text("agent").notNull(),
  skill: text("skill").notNull(),
  sourceType: text("source_type").notNull(),         // 'thumbs' | 'reorder' | 'override' | 'correction' | 'rating' | 'free_text'
  sourceId: text("source_id").notNull(),             // FK-ish to whatever the feedback is about (emailId, taskId, ideaId)
  rating: integer("rating"),                         // 1 | -1 | NULL
  reviewText: text("review_text"),
  contextSnapshot: jsonb("context_snapshot").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }), // NULL until used in a training run
  trainingRunId: uuid("training_run_id"),
  consumedOutcome: text("consumed_outcome"),         // 'proposal_created' | 'no_proposal' | 'noise'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("agent_feedback_agent_idx").on(t.agent),
  index("agent_feedback_skill_idx").on(t.skill),
  // Partial index for "available for training" queries — fast Train modal load.
  index("agent_feedback_unconsumed_idx").on(t.agent, t.createdAt).where(sql`consumed_at IS NULL`),
]);

// 5.3 Each Train-button click — tracks status, prevents double-click via partial unique-ish index.
export const agentTrainingRunsTable = pgTable("agent_training_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  agent: text("agent").notNull(),
  startedBy: text("started_by").notNull(),           // user email
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull(),                  // 'running' | 'success' | 'failed' | 'no_proposal'
  feedbackIds: uuid("feedback_ids").array().notNull(),
  proposalId: uuid("proposal_id"),                   // 0 or 1 proposal per run
  failureReason: text("failure_reason"),
}, (t) => [
  index("agent_training_runs_agent_idx").on(t.agent),
  // Partial index for "is there an active run for agent X?" — drives Train button disable state.
  index("agent_training_runs_running_idx").on(t.agent).where(sql`status = 'running'`),
]);

// 5.4 Coach output — Git-commit-style bundle of N memory-section diffs. Approved/rejected atomically.
export const agentMemoryProposalsTable = pgTable("agent_memory_proposals", {
  id: uuid("id").defaultRandom().primaryKey(),
  agent: text("agent").notNull(),
  trainingRunId: uuid("training_run_id").notNull(),
  reason: text("reason").notNull(),                  // one summary across all changes
  diffs: jsonb("diffs").notNull(),                   // [{ section_name, kind, before, after }, ...]
  feedbackIds: uuid("feedback_ids").array().notNull(),
  status: text("status").notNull(),                  // 'pending' | 'approved' | 'rejected'
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: text("decided_by"),
}, (t) => [
  index("agent_memory_proposals_agent_idx").on(t.agent),
  // Partial index for "any pending review?" banner.
  index("agent_memory_proposals_pending_idx").on(t.agent).where(sql`status = 'pending'`),
]);

// 5.5 Per-run cost/latency tracking (extends ai_usage_logs with agent/skill labels).
export const agentRunsTable = pgTable("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  agent: text("agent").notNull(),
  skill: text("skill").notNull(),
  caller: text("caller"),                            // 'direct' | 'orchestrator' | 'coach' | 'cron'
  callerThreadId: uuid("caller_thread_id"),          // chat_thread_id when caller='orchestrator'
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  cacheReadTokens: integer("cache_read_tokens").default(0),
  cacheCreationTokens: integer("cache_creation_tokens").default(0),
  costUsd: text("cost_usd"),                         // numeric stored as text to avoid float issues
  durationMs: integer("duration_ms"),
  status: text("status").notNull().default("success"), // 'success' | 'error'
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("agent_runs_agent_idx").on(t.agent),
  index("agent_runs_skill_idx").on(t.skill),
  index("agent_runs_created_idx").on(t.createdAt),
]);
