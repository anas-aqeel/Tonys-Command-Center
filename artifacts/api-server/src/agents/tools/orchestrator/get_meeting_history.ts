// get_meeting_history — orchestrator wrapper. Reads past meeting notes for a contact.

import type { ToolHandler } from "../index.js";
import { sharedDb, meetingHistoryTable } from "@workspace/db";
import { ilike, desc } from "drizzle-orm";

const handler: ToolHandler = async (input) => {
  const name = String(input.contact_name);
  const lim = typeof input.limit === "number" ? Math.min(input.limit, 20) : 5;
  const rows = await sharedDb
    .select()
    .from(meetingHistoryTable)
    .where(ilike(meetingHistoryTable.contactName, `%${name}%`))
    .orderBy(desc(meetingHistoryTable.date))
    .limit(lim);
  if (rows.length === 0) return `No meeting history found for "${name}".`;
  return rows.map((r, i) => {
    const parts = [`${i + 1}. [${r.date}] ${r.contactName ?? name}`];
    if (r.summary) parts.push(`   Summary: ${r.summary}`);
    if (r.nextSteps) parts.push(`   Next Steps: ${r.nextSteps}`);
    if (r.outcome) parts.push(`   Outcome: ${r.outcome}`);
    return parts.join("\n");
  }).join("\n\n");
};

export default handler;
