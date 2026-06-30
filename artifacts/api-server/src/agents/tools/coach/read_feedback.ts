// read_feedback — Coach tool. Load specific feedback rows by ID.
// Used to fetch the batch Tony selected on Train.

import type { ToolHandler } from "../index.js";
import { personalDb, agentFeedbackTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

interface Input {
  feedback_ids: string[];
}

const handler: ToolHandler = async (input) => {
  const { feedback_ids } = input as unknown as Input;
  if (!Array.isArray(feedback_ids) || feedback_ids.length === 0) {
    return { error: "feedback_ids must be a non-empty array of strings" };
  }

  const rows = await personalDb.select().from(agentFeedbackTable)
    .where(inArray(agentFeedbackTable.id, feedback_ids));

  return { count: rows.length, feedback: rows };
};

export default handler;
