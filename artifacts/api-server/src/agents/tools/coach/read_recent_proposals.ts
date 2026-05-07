// read_recent_proposals — Coach tool. Returns recent proposals for an agent
// with their status (pending/approved/rejected) + Tony's rejection reason +
// the diff payload so Coach can avoid re-proposing exactly what Tony just
// said no to. Without this tool, rejection reasons sit in the DB unread —
// Coach has no memory of why a proposal was rejected and can re-submit the
// same idea on the next training run.

import type { ToolHandler } from "../index.js";
import { db, agentMemoryProposalsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";

interface Input {
  agent: string;
  limit?: number;
  status?: "pending" | "approved" | "rejected" | "all";
}

const handler: ToolHandler = async (input) => {
  const { agent, limit = 10, status = "all" } = input as unknown as Input;
  if (!agent) return { error: "agent is required" };
  const cap = Math.min(Math.max(1, limit), 50);

  const filters = [eq(agentMemoryProposalsTable.agent, agent)];
  if (status !== "all") filters.push(eq(agentMemoryProposalsTable.status, status));

  const rows = await db.select({
    id: agentMemoryProposalsTable.id,
    status: agentMemoryProposalsTable.status,
    summary: agentMemoryProposalsTable.summary,
    diffs: agentMemoryProposalsTable.diffs,
    rejection_reason: agentMemoryProposalsTable.rejectionReason,
    decided_by: agentMemoryProposalsTable.decidedBy,
    decided_at: agentMemoryProposalsTable.decidedAt,
    created_at: agentMemoryProposalsTable.createdAt,
  })
    .from(agentMemoryProposalsTable)
    .where(and(...filters))
    .orderBy(desc(agentMemoryProposalsTable.createdAt))
    .limit(cap);

  return { agent, count: rows.length, proposals: rows };
};

export default handler;
