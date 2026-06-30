// recordFeedback — universal feedback capture (FEEDBACK_SYSTEM.md §3, §4).
// Called from every legacy feedback channel (thumbs, override, reorder, etc.)
// alongside existing legacy table writes during transition.
//
// Behavior:
//   - If FEEDBACK_PIPELINE_ENABLED=false: returns silently (Phase 0 default).
//   - If true: writes one agent_feedback row.
//   - Snapshot: callers can pass either:
//       (a) a pre-built `contextSnapshot` object (rare — used when the caller
//           already has all the world-state in hand), OR
//       (b) `snapshotExtra` — caller hints + the agent's per-agent capturer
//           reads DB to assemble the snapshot.
//     If neither is provided, the capturer runs with no extras.

import { personalDb, agentFeedbackTable } from "@workspace/db";
import { isFeedbackPipelineEnabled } from "./flags.js";
import { captureSnapshot } from "./snapshots/index.js";

export type FeedbackSourceType =
  | "thumbs"      // 👍/👎
  | "reorder"    // drag-drop with tonyExplanation (tasks)
  | "override"   // forced bypass (priority warning, scope block)
  | "correction" // edit-after-AI (compose modal notes, OCR field fix)
  | "rating"     // 1-5 stars (future)
  | "free_text"  // standalone review
  | "escalate";  // human escalation (e.g. ideas → Ethan) — Coach learns what's important enough to bump up the chain

export interface RecordFeedbackInput {
  agent: string;                       // 'email' | 'tasks' | ...
  skill: string;                       // 'reply.draft' | 'classify' | ...
  sourceType: FeedbackSourceType;
  sourceId: string;                    // emailId / taskId / ideaId / eventId
  rating?: 1 | -1 | null;
  reviewText?: string | null;
  /** OPTION A: pre-built snapshot (caller already has the world-state). */
  contextSnapshot?: Record<string, unknown>;
  /** OPTION B: hints for the per-agent capturer to assemble a snapshot. */
  snapshotExtra?: Record<string, unknown>;
}

export interface RecordFeedbackResult {
  /** True if a row was written. False if the pipeline is disabled (no-op). */
  recorded: boolean;
  /** The agent_feedback.id, when recorded. */
  feedbackId?: string;
}

export async function recordFeedback(input: RecordFeedbackInput): Promise<RecordFeedbackResult> {
  if (!isFeedbackPipelineEnabled()) {
    return { recorded: false };
  }

  // Resolve snapshot — pre-built wins, else capture from DB.
  let snapshot = input.contextSnapshot;
  if (!snapshot) {
    snapshot = await captureSnapshot(input.agent, input.skill, input.sourceId, input.snapshotExtra);
  }

  try {
    const inserted = await personalDb.insert(agentFeedbackTable).values({
      agent: input.agent,
      skill: input.skill,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      rating: input.rating ?? null,
      reviewText: input.reviewText ?? null,
      contextSnapshot: snapshot,
    }).returning({ id: agentFeedbackTable.id });

    return { recorded: true, feedbackId: inserted[0]?.id };
  } catch (err) {
    // Don't fail the calling handler on a feedback write — log and return.
    console.error("[recordFeedback] failed:", err instanceof Error ? err.message : err);
    return { recorded: false };
  }
}
