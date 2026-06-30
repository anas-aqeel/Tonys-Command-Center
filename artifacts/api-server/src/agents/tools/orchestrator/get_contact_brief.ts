// get_contact_brief — orchestrator wrapper. Pulls contact + intelligence + brief rows.

import type { ToolHandler } from "../index.js";
import { sharedDb, contactsTable } from "@workspace/db";
import { contactIntelligenceTable, contactBriefsTable } from "../../../lib/schema-v2.js";
import { eq, ilike, desc } from "drizzle-orm";

const handler: ToolHandler = async (input) => {
  try {
    let contact;
    if (input.contact_id) {
      [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, String(input.contact_id))).limit(1);
    } else if (input.contact_name) {
      [contact] = await sharedDb.select().from(contactsTable)
        .where(ilike(contactsTable.name, `%${String(input.contact_name)}%`))
        .limit(1);
    }
    if (!contact) return `No contact found for "${input.contact_name || input.contact_id}".`;

    const [intel] = await sharedDb.select().from(contactIntelligenceTable)
      .where(eq(contactIntelligenceTable.contactId, contact.id)).limit(1);

    const [brief] = await sharedDb.select().from(contactBriefsTable)
      .where(eq(contactBriefsTable.contactId, contact.id))
      .orderBy(desc(contactBriefsTable.generatedAt))
      .limit(1);

    let result = `CONTACT: ${contact.name}\nCompany: ${contact.company || "N/A"}\nStatus: ${contact.status}\nPhone: ${contact.phone || "N/A"}\nEmail: ${contact.email || "N/A"}\nType: ${contact.type || "N/A"}\nNext Step: ${contact.nextStep || "None"}`;

    if (intel) {
      result += `\n\nINTELLIGENCE:\nAI Score: ${intel.aiScore || "Not scored"}\nStage: ${intel.stage}\nTotal Calls: ${intel.totalCalls}\nTotal Emails: ${intel.totalEmailsSent} sent / ${intel.totalEmailsReceived} received\nLast Comm: ${intel.lastCommunicationDate || "Never"} via ${intel.lastCommunicationType || "N/A"}`;
      if (intel.personalityNotes) result += `\nPersonality: ${intel.personalityNotes}`;
      if (intel.nextAction) result += `\nNext Action: ${intel.nextAction} (${intel.nextActionDate || "no date"})`;
    }

    if (brief?.briefText) {
      result += `\n\nAI BRIEF:\n${brief.briefText.slice(0, 500)}`;
    }

    return result;
  } catch (err) {
    return `Contact lookup failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export default handler;
