import { pgTable, uuid, text, numeric, timestamp, date, integer, jsonb, boolean, index, uniqueIndex, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contactsTable } from "./tcc";

export const contactIntelligenceTable = pgTable("contact_intelligence", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id").references(() => contactsTable.id, { onDelete: "cascade" }).unique(),
  aiScore: numeric("ai_score", { precision: 5, scale: 2 }),
  aiScoreReason: text("ai_score_reason"),
  aiTags: text("ai_tags").array(),
  stage: text("stage").default("new"),
  lastAiScan: timestamp("last_ai_scan", { withTimezone: true }),
  linkedinUrl: text("linkedin_url"),
  socialProfiles: jsonb("social_profiles").default("{}"),
  companyInfo: jsonb("company_info").default("{}"),
  personalityNotes: text("personality_notes"),
  totalCalls: integer("total_calls").default(0),
  totalEmailsSent: integer("total_emails_sent").default(0),
  totalEmailsReceived: integer("total_emails_received").default(0),
  totalTexts: integer("total_texts").default(0),
  totalMeetings: integer("total_meetings").default(0),
  lastCommunicationDate: timestamp("last_communication_date", { withTimezone: true }),
  lastCommunicationType: text("last_communication_type"),
  lastCommunicationSummary: text("last_communication_summary"),
  nextAction: text("next_action"),
  nextActionDate: date("next_action_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_ci_contact").on(table.contactId),
  index("idx_ci_score").on(table.aiScore),
]);

export const communicationLogTable = pgTable("communication_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
  contactName: text("contact_name"),
  channel: text("channel").notNull(),
  direction: text("direction"),
  subject: text("subject"),
  summary: text("summary"),
  fullContent: text("full_content"),
  sentiment: text("sentiment"),
  actionItems: text("action_items").array(),
  gmailThreadId: text("gmail_thread_id"),
  gmailMessageId: text("gmail_message_id"),
  calendarEventId: text("calendar_event_id"),
  plaudTranscriptPath: text("plaud_transcript_path"),
  loggedAt: timestamp("logged_at", { withTimezone: true }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_cl_contact").on(table.contactId),
  index("idx_cl_date").on(table.loggedAt),
  index("idx_cl_channel").on(table.channel),
]);

export const contactBriefsTable = pgTable("contact_briefs", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id").references(() => contactsTable.id, { onDelete: "cascade" }),
  contactName: text("contact_name").notNull(),
  briefText: text("brief_text").notNull(),
  openTasks: text("open_tasks").array(),
  recentCommunications: jsonb("recent_communications"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_cb_contact").on(table.contactId),
]);

export const businessContextTable = pgTable("business_context", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentType: text("document_type").notNull().unique(),
  content: text("content").notNull(),
  summary: text("summary"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const dailySuggestionsTable = pgTable("daily_suggestions", {
  id: uuid("id").defaultRandom().primaryKey(),
  date: date("date").notNull().unique(),
  urgentResponses: jsonb("urgent_responses"),
  followUps: jsonb("follow_ups"),
  top10New: jsonb("top_10_new"),
  pipelineSummary: jsonb("pipeline_summary"),
  teamAlerts: jsonb("team_alerts"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_ds_date").on(table.date),
]);

export const chatThreadsTable = pgTable("chat_threads", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title"),
  contextType: text("context_type").default("general"),
  contextId: text("context_id"),
  pinned: boolean("pinned").default(false).notNull(),
  pinnedAt: timestamp("pinned_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const chatMessagesTable = pgTable("chat_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id").references(() => chatThreadsTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_cm_thread").on(table.threadId),
  index("idx_cm_created").on(table.createdAt),
]);

export const taskWorkNotesTable = pgTable("task_work_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: text("task_id").notNull(),
  date: date("date").notNull(),
  note: text("note").notNull(),
  progress: integer("progress").default(0),
  nextSessionDate: date("next_session_date"),
  nextSteps: text("next_steps"),
  driveFileId: text("drive_file_id"),
  driveFileName: text("drive_file_name"),
  driveLinkUrl: text("drive_link_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_twn_task").on(table.taskId),
  index("idx_twn_date").on(table.date),
]);

export const localTasksTable = pgTable("local_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  text: text("text").notNull(),
  dueDate: date("due_date"),
  priority: integer("priority").default(50),
  status: text("status").default("active"),
  overrideWarning: text("override_warning"),
  googleTaskId: text("google_task_id"),
  taskType: text("task_type").default("one_time"),
  size: text("size"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_lt_status").on(table.status),
  index("idx_lt_due").on(table.dueDate),
]);

export const scratchNotesTable = pgTable("scratch_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  text: text("text").notNull(),
  checked: boolean("checked").default(false).notNull(),
  position: integer("position").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_sn_position").on(table.position),
]);

export const manualScheduleEventsTable = pgTable("manual_schedule_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  date: date("date").notNull(),
  time: text("time").notNull(),
  timeEnd: text("time_end"),
  title: text("title").notNull(),
  type: text("type").notNull(),
  category: text("category").notNull(),
  importance: text("importance").default("mid"),
  person: text("person"),
  contactId: uuid("contact_id"),
  description: text("description"),
  briefing: text("briefing"),
  forcedOverride: integer("forced_override").default(0),
  overrideReason: text("override_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_mse_date").on(table.date),
]);

export const companyGoalsTable = pgTable("company_goals", {
  id: uuid("id").defaultRandom().primaryKey(),
  horizon: text("horizon").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  owner: text("owner").default("Tony"),
  status: text("status").default("active"),
  dueDate: date("due_date"),
  position: integer("position").default(0),
  sheetRowRef: text("sheet_row_ref").unique(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("idx_cg_horizon_title").on(table.horizon, table.title),
  index("idx_cg_horizon").on(table.horizon),
  index("idx_cg_owner").on(table.owner),
  index("idx_cg_status").on(table.status),
  index("idx_cg_position").on(table.position),
]);

export const teamRolesTable = pgTable("team_roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  slackId: text("slack_id"),
  email: text("email"),
  role: text("role").notNull(),
  responsibilities: jsonb("responsibilities").default("[]"),
  currentFocus: text("current_focus"),
  metrics: jsonb("metrics").default("{}"),
  position: integer("position").default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_tr_name").on(table.name),
]);

export const goalCompletionsTable = pgTable("goal_completions", {
  id: uuid("id").defaultRandom().primaryKey(),
  goalId: uuid("goal_id").references(() => companyGoalsTable.id, { onDelete: "cascade" }),
  goalTitle: text("goal_title").notNull(),
  horizon: text("horizon").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).defaultNow(),
});

export const planItemsTable = pgTable("plan_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  level: text("level").notNull(),
  category: text("category").notNull(),
  subcategory: text("subcategory"),
  title: text("title").notNull(),
  description: text("description"),
  owner: text("owner"),
  coOwner: text("co_owner"),
  priority: text("priority"),
  status: text("status").default("active"),
  priorityOrder: integer("priority_order").default(0),
  parentId: uuid("parent_id"),
  month: text("month"),
  dueDate: date("due_date"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: text("completed_by"),
  linkedTaskId: uuid("linked_task_id"),
  linearId: text("linear_id"),
  source: text("source"),
  atomicKpi: text("atomic_kpi"),
  workNotes: text("work_notes"),
  executionTier: text("execution_tier"),
  taskType: text("task_type").default("master"),
  parentTaskId: uuid("parent_task_id"),
  // Highlight feature (Tony's 2026-05-16 screenshare + PDF "Ability to Add
  // Notes and Highlight"). Color = which "focus bucket" the task is in (e.g.
  // yellow = Ramy, blue = Ethan, or any per-task choice). Note = short text
  // shown on hover. Highlighted tasks must have a dueDate (FE enforces).
  highlightColor: text("highlight_color"),
  highlightNote: text("highlight_note"),
  highlightAt: timestamp("highlight_at", { withTimezone: true }),
  // Links feature (Tony's 2026-05-16 PDF): array of {url, label?, createdAt}
  // attached to the task — Loom recordings, Docs, Linear web links, etc.
  // Stored as JSONB array; managed via the task detail modal's Links section.
  links: jsonb("links").default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_pi_level").on(table.level),
  index("idx_pi_category").on(table.category),
  index("idx_pi_parent_id").on(table.parentId),
  index("idx_pi_parent_task_id").on(table.parentTaskId),
  index("idx_pi_task_type").on(table.taskType),
  index("idx_pi_month").on(table.month),
  index("idx_pi_status").on(table.status),
]);

export const aiUsageLogsTable = pgTable("ai_usage_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  featureName: text("feature_name").notNull(),
  tier: text("tier"),                                      // 'basic' | 'medium' | 'complex' (multi-provider)
  provider: text("provider").notNull().default("anthropic"),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  totalTokens: integer("total_tokens").default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens").default(0),
  inputCostUsd: numeric("input_cost_usd", { precision: 10, scale: 6 }),
  outputCostUsd: numeric("output_cost_usd", { precision: 10, scale: 6 }),
  totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 6 }),
  requestSummary: text("request_summary"),
  responseSummary: text("response_summary"),
  fullRequest: jsonb("full_request"),
  fullResponse: jsonb("full_response"),
  durationMs: integer("duration_ms"),
  status: text("status").notNull().default("success"),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"),
}, (table) => [
  index("idx_aul_timestamp").on(table.timestamp),
  index("idx_aul_feature").on(table.featureName),
  index("idx_aul_provider").on(table.provider),
  index("idx_aul_model").on(table.model),
  index("idx_aul_tier").on(table.tier),
]);

// Per-tier provider/model/key configuration. Powers the model-agnostic
// settings UI at /settings/models. API keys are stored as AES-256-GCM
// ciphertext (cipher + iv + auth tag); see lib/integrations-anthropic-ai/src/secrets.ts.
export const aiProviderSettingsTable = pgTable("ai_provider_settings", {
  tier: text("tier").primaryKey(),                                  // 'basic' | 'medium' | 'complex'
  provider: text("provider").notNull(),                             // 'anthropic' | 'openai' | 'google' | 'openrouter'
  model: text("model").notNull(),                                   // free-form; provider validates at call time
  apiKeyCipher: customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })("api_key_cipher"),
  apiKeyIv: customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })("api_key_iv"),
  apiKeyTag: customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })("api_key_tag"),
  baseUrl: text("base_url"),                                        // optional (Vertex region, OpenAI-compatible self-host)
  extraOptions: jsonb("extra_options").notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

export const brainTrainingLogTable = pgTable("brain_training_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  movedItemId: uuid("moved_item_id").references(() => planItemsTable.id, { onDelete: "cascade" }),
  movedItemTitle: text("moved_item_title"),
  fromPosition: integer("from_position"),
  toPosition: integer("to_position"),
  displacedItemIds: uuid("displaced_item_ids").array(),
  displacedItemTitles: text("displaced_item_titles").array(),
  tonyExplanation: text("tony_explanation").notNull(),
  aiReflection: text("ai_reflection"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_btl_moved").on(table.movedItemId),
  index("idx_btl_created").on(table.createdAt),
]);

export const linearPrioritiesTable = pgTable("linear_priorities", {
  id: uuid("id").defaultRandom().primaryKey(),
  priorityOrder: integer("priority_order").notNull(),
  linearRef: text("linear_ref").notNull(),
  isProject: boolean("is_project").notNull().default(false),
  title: text("title").notNull(),
  status: text("status").notNull().default(""),
  priority: text("priority").notNull().default(""),
  owner: text("owner"),
  team: text("team"),
  q2PlanRef: text("q2_plan_ref"),
  action: text("action").notNull(),
  why: text("why").notNull().default(""),
  nextStep: text("next_step"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_lp_order").on(table.priorityOrder),
  index("idx_lp_action").on(table.action),
]);
