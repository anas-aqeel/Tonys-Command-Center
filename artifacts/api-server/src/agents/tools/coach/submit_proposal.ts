// submit_proposal — Coach's primary write tool. Creates one agent_memory_proposals
// row bundling N memory-section diffs.
//
// HARD RULES enforced here:
//   1. Every diff.kind MUST be 'memory'. Other kinds are git-locked.
//   2. The diff.section_name MUST NOT be 'evaluation-log' on agent='coach'
//      (use append_to_evaluation_log for that).
//   3. Coach can call this AT MOST ONCE per training run. Second call rejected.
//   4. trainingRunId must be present on context (set by analyzeFeedback caller).

import type { ToolHandler } from "../index.js";
import { personalDb, agentMemoryProposalsTable, agentTrainingRunsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

interface DiffInput {
  section_name: string;
  kind: string;
  before: string;
  after: string;
}
interface Input {
  agent: string;
  reason: string;
  diffs: DiffInput[];
  feedback_ids: string[];
}

const FORBIDDEN_KINDS = new Set(["soul", "user", "identity", "agents", "tools", "skill"]);

const handler: ToolHandler = async (input, ctx) => {
  const { agent, reason, diffs, feedback_ids } = input as unknown as Input;

  // Validate inputs
  if (!agent || typeof agent !== "string") {
    return { error: "agent is required (string)" };
  }
  if (!reason || typeof reason !== "string" || reason.length < 10) {
    return { error: "reason is required and should be at least 10 chars" };
  }
  if (!Array.isArray(diffs) || diffs.length === 0) {
    return { error: "diffs must be a non-empty array" };
  }
  if (!Array.isArray(feedback_ids) || feedback_ids.length === 0) {
    return { error: "feedback_ids must be a non-empty array" };
  }
  if (!ctx.trainingRunId) {
    return { error: "trainingRunId not on context — submit_proposal can only be called from within an active Coach training run" };
  }

  // Enforce kind=memory and forbid coach-self-evaluation-log (use append_to_evaluation_log instead)
  for (const d of diffs) {
    if (d.kind !== "memory") {
      return { error: `diff for section_name='${d.section_name}' has kind='${d.kind}' — only kind='memory' is allowed` };
    }
    if (FORBIDDEN_KINDS.has(d.kind)) {
      return { error: `kind='${d.kind}' is forbidden — Coach may only edit kind='memory'` };
    }
    if (agent === "coach" && d.section_name === "evaluation-log") {
      return { error: "Cannot edit coach/evaluation-log via proposal — use append_to_evaluation_log tool instead" };
    }
  }

  // Enforce at-most-one-proposal-per-run.
  const [existing] = await personalDb.select({ id: agentMemoryProposalsTable.id })
    .from(agentMemoryProposalsTable)
    .where(eq(agentMemoryProposalsTable.trainingRunId, ctx.trainingRunId))
    .limit(1);
  if (existing) {
    return { error: `A proposal (${existing.id}) was already submitted for this training run. Coach may submit at most one proposal per run.` };
  }

  // Insert
  const [row] = await personalDb.insert(agentMemoryProposalsTable).values({
    agent,
    trainingRunId: ctx.trainingRunId,
    reason,
    diffs: diffs.map(d => ({
      section_name: d.section_name,
      kind: d.kind,
      before: d.before ?? "",
      after: d.after ?? "",
    })),
    feedbackIds: feedback_ids,
    status: "pending",
  }).returning({ id: agentMemoryProposalsTable.id });

  // Stamp the run with the proposal id (lets Train UI flip from running → pending review).
  await personalDb.update(agentTrainingRunsTable).set({
    proposalId: row.id,
  }).where(eq(agentTrainingRunsTable.id, ctx.trainingRunId));

  return {
    ok: true,
    proposal_id: row.id,
    diff_count: diffs.length,
    feedback_count: feedback_ids.length,
  };
};

export default handler;
