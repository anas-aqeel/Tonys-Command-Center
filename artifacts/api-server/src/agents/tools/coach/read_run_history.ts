// read_run_history — Coach tool. Recent runs of a specialist's skill.
// Used when reasoning about whether the issue is a memory gap vs a brittle skill body.

import type { ToolHandler } from "../index.js";
import { personalDb, agentRunsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";

interface Input {
  agent: string;
  skill: string;
  limit?: number;
}

const handler: ToolHandler = async (input) => {
  const { agent, skill, limit = 20 } = input as unknown as Input;
  if (!agent || !skill) {
    return { error: "agent and skill are required" };
  }
  const cap = Math.min(Math.max(1, limit), 100);

  const rows = await personalDb.select({
    caller: agentRunsTable.caller,
    input_tokens: agentRunsTable.inputTokens,
    output_tokens: agentRunsTable.outputTokens,
    cache_read_tokens: agentRunsTable.cacheReadTokens,
    duration_ms: agentRunsTable.durationMs,
    status: agentRunsTable.status,
    error_message: agentRunsTable.errorMessage,
    created_at: agentRunsTable.createdAt,
  })
    .from(agentRunsTable)
    .where(and(eq(agentRunsTable.agent, agent), eq(agentRunsTable.skill, skill)))
    .orderBy(desc(agentRunsTable.createdAt))
    .limit(cap);

  return { agent, skill, count: rows.length, runs: rows };
};

export default handler;
