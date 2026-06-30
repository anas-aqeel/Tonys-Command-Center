// get_business_context — orchestrator wrapper. Returns all business_context rows.

import type { ToolHandler } from "../index.js";
import { sharedDb } from "@workspace/db";
import { businessContextTable } from "../../../lib/schema-v2.js";
import { desc } from "drizzle-orm";

const handler: ToolHandler = async () => {
  const rows = await sharedDb.select().from(businessContextTable).orderBy(desc(businessContextTable.lastUpdated));
  if (rows.length === 0) return "No business context documents stored yet.";
  return rows.map(r => {
    const header = `=== ${r.documentType?.toUpperCase() || "DOCUMENT"} (updated ${r.lastUpdated ? new Date(r.lastUpdated).toLocaleDateString("en-US") : "unknown"}) ===`;
    const body = r.content ? r.content.slice(0, 3000) : r.summary || "(no content)";
    return `${header}\n${body}`;
  }).join("\n\n");
};

export default handler;
