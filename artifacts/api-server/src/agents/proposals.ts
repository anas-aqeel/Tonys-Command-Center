// Proposal queue — read/write helpers for agent_memory_proposals.
// Called from /api/agents/* routes (training-state, approve, reject) and
// internally by coach.ts when it produces a proposal.

import { db, agentMemoryProposalsTable, agentTrainingRunsTable, agentFeedbackTable, agentMemoryEntriesTable } from "@workspace/db";
import { and, eq, sql, isNull } from "drizzle-orm";

// Per FEEDBACK_SYSTEM.md §8: a proposal is an atomic bundle of N memory-section diffs.
export interface MemoryDiff {
  sectionName: string;
  kind: "memory";              // Coach can ONLY edit kind='memory' entries (D5).
  before: string;              // Existing content (or "" if section doesn't exist yet).
  after: string;               // Proposed new content.
}

export interface ProposalCreateInput {
  agent: string;
  trainingRunId: string;
  reason: string;              // One-line summary across all diffs.
  diffs: MemoryDiff[];
  feedbackIds: string[];
}

export async function createProposal(input: ProposalCreateInput): Promise<string> {
  const inserted = await db.insert(agentMemoryProposalsTable).values({
    agent: input.agent,
    trainingRunId: input.trainingRunId,
    reason: input.reason,
    diffs: input.diffs,
    feedbackIds: input.feedbackIds,
    status: "pending",
  }).returning({ id: agentMemoryProposalsTable.id });
  return inserted[0]!.id;
}

export interface TrainingState {
  is_running: boolean;
  run_id: string | null;
  started_at: string | null;
  unconsumed_count: number;
  pending_proposals_count: number;
}

export async function getTrainingState(agent: string): Promise<TrainingState> {
  // Find any running training run for this agent (partial index makes this fast).
  const [running] = await db.select({
    id: agentTrainingRunsTable.id,
    startedAt: agentTrainingRunsTable.startedAt,
  })
    .from(agentTrainingRunsTable)
    .where(and(eq(agentTrainingRunsTable.agent, agent), eq(agentTrainingRunsTable.status, "running")))
    .limit(1);

  // Count unconsumed feedback rows.
  const [unconsumed] = await db.select({ count: sql<number>`COUNT(*)::int` })
    .from(agentFeedbackTable)
    .where(and(eq(agentFeedbackTable.agent, agent), isNull(agentFeedbackTable.consumedAt)));

  // Count pending proposals.
  const [pending] = await db.select({ count: sql<number>`COUNT(*)::int` })
    .from(agentMemoryProposalsTable)
    .where(and(eq(agentMemoryProposalsTable.agent, agent), eq(agentMemoryProposalsTable.status, "pending")));

  return {
    is_running: !!running,
    run_id: running?.id ?? null,
    started_at: running?.startedAt?.toISOString() ?? null,
    unconsumed_count: unconsumed?.count ?? 0,
    pending_proposals_count: pending?.count ?? 0,
  };
}

// Apply an approved proposal — write each diff into agent_memory_entries.
// Atomic: all diffs apply or none (transaction).
//
// Archive: the *actually replaced* content is stamped into each diff as
// `before_at_apply` before the overwrite. This preserves the real prior
// content (which may differ from Coach's earlier `before` snapshot if Tony
// edited the section in between) so the proposal row functions as the audit
// trail / rollback source.
export async function applyApprovedProposal(proposalId: string, decidedBy: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [proposal] = await tx.select().from(agentMemoryProposalsTable)
      .where(eq(agentMemoryProposalsTable.id, proposalId))
      .limit(1);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
    if (proposal.status !== "pending") throw new Error(`Proposal ${proposalId} is ${proposal.status}, not pending`);

    // Coach's submit_proposal stores diffs with snake_case keys to match the
    // tool's Anthropic schema. Normalize here so we tolerate either casing.
    const diffs = proposal.diffs as Array<{ kind: string; section_name?: string; sectionName?: string; before?: string; before_at_apply?: string; after: string }>;
    const archivedDiffs: typeof diffs = [];
    for (const d of diffs) {
      const sectionName = d.section_name ?? d.sectionName;
      if (!sectionName) {
        throw new Error(`Diff missing section_name: ${JSON.stringify(d).slice(0, 200)}`);
      }

      // Read the live content before we overwrite it — that's the real archive.
      const [existing] = await tx.select({ content: agentMemoryEntriesTable.content })
        .from(agentMemoryEntriesTable)
        .where(and(
          eq(agentMemoryEntriesTable.agent, proposal.agent),
          eq(agentMemoryEntriesTable.kind, d.kind),
          eq(agentMemoryEntriesTable.sectionName, sectionName),
        ))
        .limit(1);
      const beforeAtApply = existing?.content ?? "";
      archivedDiffs.push({ ...d, before_at_apply: beforeAtApply });

      await tx.insert(agentMemoryEntriesTable)
        .values({
          agent: proposal.agent,
          kind: d.kind,
          sectionName,
          content: d.after,
          updatedBy: "coach",
        })
        .onConflictDoUpdate({
          target: [agentMemoryEntriesTable.agent, agentMemoryEntriesTable.kind, agentMemoryEntriesTable.sectionName],
          set: {
            content: d.after,
            version: sql`${agentMemoryEntriesTable.version} + 1`,
            updatedAt: new Date(),
            updatedBy: "coach",
          },
        });
    }

    await tx.update(agentMemoryProposalsTable).set({
      status: "approved",
      decidedAt: new Date(),
      decidedBy,
      diffs: archivedDiffs,
    }).where(eq(agentMemoryProposalsTable.id, proposalId));
  });
}

export async function rejectProposal(proposalId: string, decidedBy: string, reason?: string): Promise<void> {
  await db.update(agentMemoryProposalsTable).set({
    status: "rejected",
    decidedAt: new Date(),
    decidedBy,
    rejectionReason: reason ?? null,
  }).where(eq(agentMemoryProposalsTable.id, proposalId));
}
