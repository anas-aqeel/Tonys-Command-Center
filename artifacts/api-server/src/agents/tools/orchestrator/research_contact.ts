// research_contact — orchestrator wrapper. Deep contact research with last-5
// interactions. Preserves the dynamic import of communicationLogTable from
// claude.ts (audit's CRITICAL NOTES item #3).

import type { ToolHandler } from "../index.js";
import { sharedDb, contactsTable } from "@workspace/db";
import { contactIntelligenceTable } from "../../../lib/schema-v2.js";
import { eq, ilike, desc, sql } from "drizzle-orm";

const handler: ToolHandler = async (input) => {
  try {
    const { communicationLogTable: commLog } = await import("../../../lib/schema-v2.js");
    let contact;
    if (input.contactId) {
      [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, String(input.contactId))).limit(1);
    } else if (input.contactName) {
      [contact] = await sharedDb.select().from(contactsTable)
        .where(ilike(contactsTable.name, `%${String(input.contactName)}%`)).limit(1);
    }
    if (!contact) return `No contact found for "${input.contactName || input.contactId}".`;

    const [intel] = await sharedDb.select().from(contactIntelligenceTable)
      .where(eq(contactIntelligenceTable.contactId, contact.id)).limit(1);

    const recentComms = await sharedDb.select().from(commLog)
      .where(eq(commLog.contactId, contact.id))
      .orderBy(desc(commLog.loggedAt))
      .limit(5);

    const totalComms = await sharedDb.select({ count: sql<number>`count(*)` }).from(commLog)
      .where(eq(commLog.contactId, contact.id));
    const total = Number(totalComms[0]?.count ?? 0);

    let result = `🔍 CONTACT RESEARCH: ${contact.name}\n`;
    result += `Company: ${contact.company || "N/A"} | Type: ${contact.type || "N/A"}\n`;
    result += `Status: ${contact.status} | Phone: ${contact.phone || "N/A"} | Email: ${contact.email || "N/A"}\n`;
    result += `Next Step: ${contact.nextStep || "None"}\n`;

    if (intel) {
      result += `\n📊 INTELLIGENCE\n`;
      result += `AI Score: ${intel.aiScore || "Not scored"} | Stage: ${intel.stage}\n`;
      result += `Total Interactions: ${total} | Last Comm: ${intel.lastCommunicationDate || "Never"} via ${intel.lastCommunicationType || "N/A"}\n`;
      if (intel.personalityNotes) result += `Personality: ${intel.personalityNotes}\n`;
      if (intel.nextAction) result += `Next Action: ${intel.nextAction}${intel.nextActionDate ? ` by ${intel.nextActionDate}` : ""}\n`;
    }

    if (recentComms.length > 0) {
      result += `\n📝 LAST ${recentComms.length} INTERACTIONS\n`;
      recentComms.forEach((c, i) => {
        const date = c.loggedAt ? new Date(c.loggedAt).toLocaleDateString("en-US") : "unknown date";
        result += `${i + 1}. [${date}] ${c.channel}: ${c.summary || c.subject || "(no summary)"}\n`;
      });
    }

    return result;
  } catch (err) {
    return `Research failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export default handler;
