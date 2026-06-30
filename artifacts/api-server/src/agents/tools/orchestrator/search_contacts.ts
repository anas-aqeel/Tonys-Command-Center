// search_contacts — orchestrator wrapper. OR-search by name/company/type.

import type { ToolHandler } from "../index.js";
import { sharedDb, contactsTable } from "@workspace/db";
import { ilike, or } from "drizzle-orm";

const handler: ToolHandler = async (input) => {
  try {
    const query = String(input.query);
    const limit = typeof input.limit === "number" ? Math.min(input.limit, 20) : 5;
    const contacts = await sharedDb.select().from(contactsTable)
      .where(
        or(
          ilike(contactsTable.name, `%${query}%`),
          ilike(contactsTable.company, `%${query}%`),
          ilike(contactsTable.type, `%${query}%`),
        )
      )
      .limit(limit);

    if (contacts.length === 0) return `No contacts found for "${query}".`;
    return contacts.map((c, i) =>
      `${i + 1}. ${c.name}${c.company ? ` (${c.company})` : ""}\n   Status: ${c.status} | Type: ${c.type || "N/A"} | Phone: ${c.phone || "N/A"} | Stage: ${c.pipelineStage || "Lead"}`
    ).join("\n\n");
  } catch (err) {
    return `Contact search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export default handler;
