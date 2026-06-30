// read_recent_feedback — Coach tool. Surface broader recent feedback for an agent.
// Used to detect cross-batch patterns (this Train run + ambient context).

import type { ToolHandler } from "../index.js";
import { personalDb, agentFeedbackTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

interface Input {
  agent: string;
  limit?: number;
}

const handler: ToolHandler = async (input) => {
  const { agent, limit = 50 } = input as unknown as Input;
  if (!agent || typeof agent !== "string") {
    return { error: "agent is required (string)" };
  }
  const cap = Math.min(Math.max(1, limit), 200);

  const rows = await personalDb.select().from(agentFeedbackTable)
    .where(eq(agentFeedbackTable.agent, agent))
    .orderBy(desc(agentFeedbackTable.createdAt))
    .limit(cap);

  return { agent, count: rows.length, feedback: rows };
};

export default handler;
