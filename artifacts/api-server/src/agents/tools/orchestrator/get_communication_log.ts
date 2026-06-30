// get_communication_log — orchestrator wrapper. Reads communication_log entries.
// Note: channel filter is documented in the schema but not implemented (audit
// note #5). Preserved as-is.

import type { ToolHandler } from "../index.js";
import { sharedDb, contactsTable } from "@workspace/db";
import { communicationLogTable } from "../../../lib/schema-v2.js";
import { eq, ilike, desc } from "drizzle-orm";

const handler: ToolHandler = async (input) => {
  try {
    const lim = typeof input.limit === "number" ? Math.min(input.limit, 50) : 20;
    let query = sharedDb.select().from(communicationLogTable);
    if (input.contact_name) {
      const [contact] = await sharedDb.select().from(contactsTable)
        .where(ilike(contactsTable.name, `%${String(input.contact_name)}%`)).limit(1);
      if (contact) {
        // @ts-ignore dynamic where
        query = query.where(eq(communicationLogTable.contactId, contact.id));
      }
    }
    const rows = await query.orderBy(desc(communicationLogTable.loggedAt)).limit(lim);
    if (rows.length === 0) return "No communication log entries found.";
    return rows.map((r, i) => {
      const date = r.loggedAt ? new Date(r.loggedAt).toLocaleDateString("en-US") : "unknown";
      return `${i + 1}. [${date}] ${r.channel || "?"}: ${r.summary || r.subject || "(no summary)"}`;
    }).join("\n");
  } catch (err) {
    return `Communication log failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export default handler;
