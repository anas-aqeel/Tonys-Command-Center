// log_meeting_context — orchestrator wrapper. Inserts a meeting record.

import type { ToolHandler } from "../index.js";
import { sharedDb, meetingHistoryTable } from "@workspace/db";

const handler: ToolHandler = async (input) => {
  const [row] = await sharedDb
    .insert(meetingHistoryTable)
    .values({
      date: String(input.date),
      contactName: String(input.contact_name),
      summary: input.summary ? String(input.summary) : null,
      nextSteps: input.next_steps ? String(input.next_steps) : null,
      outcome: input.outcome ? String(input.outcome) : null,
    })
    .returning();
  return `✓ Meeting context logged for ${input.contact_name} on ${input.date} (id: ${row.id})`;
};

export default handler;
