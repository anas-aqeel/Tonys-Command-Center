// get_email_brain — orchestrator wrapper. Retrieves Tony's learned email
// priority rules from the system_instructions table.

import type { ToolHandler } from "../index.js";
import { personalDb, systemInstructionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const handler: ToolHandler = async () => {
  const [row] = await personalDb
    .select()
    .from(systemInstructionsTable)
    .where(eq(systemInstructionsTable.section, "email_brain"));
  if (row?.content) return `Email Brain:\n${row.content}`;
  return "No email brain yet — no training data available.";
};

export default handler;
