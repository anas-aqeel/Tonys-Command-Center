// list_all_contacts — orchestrator wrapper. Returns id+name+company for every
// contact so the AI can fuzzy-match a misspelled or partial name by reading
// the full namespace and proposing close candidates back to Tony. Kept narrow
// (3 fields) to stay token-cheap; for richer info use search_contacts on the
// chosen name.

import type { ToolHandler } from "../index.js";
import { sharedDb, contactsTable } from "@workspace/db";
import { asc } from "drizzle-orm";

const handler: ToolHandler = async () => {
  try {
    const rows = await sharedDb
      .select({ id: contactsTable.id, name: contactsTable.name, company: contactsTable.company })
      .from(contactsTable)
      .orderBy(asc(contactsTable.name));

    if (rows.length === 0) return "No contacts in database.";

    return [
      `${rows.length} contact${rows.length === 1 ? "" : "s"} in database (id · name · company):`,
      ...rows.map(r => `${r.id} · ${r.name}${r.company ? ` · ${r.company}` : ""}`),
    ].join("\n");
  } catch (err) {
    return `list_all_contacts failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export default handler;
