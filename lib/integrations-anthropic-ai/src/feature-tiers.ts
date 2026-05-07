// Maps every featureName used in createTrackedMessage / runAgent / streamed
// chat to a tier. Tier resolution drives provider+model selection at runtime
// via ai_provider_settings. Unmapped features fall back to 'medium' with a
// console warning so we know to add them.
//
// Maintenance rule: when adding a new createTrackedMessage call site, add
// its featureName here. Otherwise it silently uses the medium-tier default.

export type Tier = "basic" | "medium" | "complex";

export const FEATURE_TIER_MAP: Record<string, Tier> = {
  // ── BASIC: single-shot, deterministic, classification/scoring ───────────
  email_poll: "basic",
  email_poll_scan: "basic",
  contacts_score: "basic",
  idea_classify: "basic",
  task_classify: "basic",
  plan_prioritize: "basic",
  schedule_optimize: "basic",
  schedule_next: "basic",
  calls_analyze: "basic",
  call_follow_up: "basic",
  checkin_generate: "basic",
  tasks_generate: "basic",
  chat_thread_title: "basic",
  plaud_transcribe: "basic",
  demo_feedback: "basic",
  brief_email_triage: "basic",  // 3-bucket classification, not synthesis
  brief_claude_generate: "basic",  // hallucinated-fallback brief; cheap model is fine
  agent_email_triage: "basic",  // same call routed via runtime; classification, not synthesis

  // ── MEDIUM: synthesis with context, drafting, summarization ─────────────
  brief_generate: "medium",
  brief_anchor: "medium",
  email_draft: "medium",
  email_brain_regen: "medium",
  email_action: "medium",
  agent_email_rewrite: "medium",
  contacts_brief: "medium",
  contact_brief: "medium",
  contact_brief_regen: "medium",
  contacts_research: "medium",
  contact_research: "medium",
  contact_card_ocr: "medium",
  eod_preview: "medium",
  eod_report: "medium",
  meeting_summary: "medium",
  meeting_history_extract: "medium",
  sheet_analysis: "medium",
  sheet_scan: "medium",
  sheets_sync: "medium",
  journal_format: "medium",
  journal_summarize: "medium",
  plan_organize: "medium",
  chat_thread: "medium",      // streaming chat
  chat_response: "medium",
  checkin_accountability: "medium",
};

/**
 * Resolve a featureName to its tier. Multi-turn agent calls (featureName
 * shape `agent_<agent>_<skill>`) default to 'complex' unless an explicit
 * mapping exists.
 */
export function tierFor(featureName: string): Tier {
  const explicit = FEATURE_TIER_MAP[featureName];
  if (explicit) return explicit;
  if (featureName.startsWith("agent_")) return "complex";
  // Unmapped one-shot feature → medium fallback.
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[feature-tiers] unmapped featureName='${featureName}' → defaulting to 'medium'`);
  }
  return "medium";
}
