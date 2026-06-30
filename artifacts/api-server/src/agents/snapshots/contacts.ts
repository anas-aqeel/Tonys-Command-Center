// Contacts feedback snapshot — for research / card-ocr / pre-call-brief feedback.

import { sharedDb, contactsTable, contactIntelligenceTable, contactBriefsTable, communicationLogTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function captureContactsSnapshot(
  skill: string,
  sourceId: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let contact: any = null;
  let intelligence: any = null;
  let brief: any = null;
  let recentComms: any[] = [];

  if (sourceId && /^[0-9a-f-]{36}$/i.test(sourceId)) {
    const [c] = await sharedDb.select().from(contactsTable)
      .where(eq(contactsTable.id, sourceId))
      .limit(1);
    contact = c || null;

    if (contact?.id) {
      const [i] = await sharedDb.select().from(contactIntelligenceTable)
        .where(eq(contactIntelligenceTable.contactId, contact.id))
        .limit(1);
      intelligence = i || null;

      const [b] = await sharedDb.select().from(contactBriefsTable)
        .where(eq(contactBriefsTable.contactId, contact.id))
        .orderBy(desc(contactBriefsTable.generatedAt))
        .limit(1);
      brief = b || null;

      recentComms = await sharedDb.select().from(communicationLogTable)
        .where(eq(communicationLogTable.contactId, contact.id))
        .orderBy(desc(communicationLogTable.loggedAt))
        .limit(6);
    }
  }

  return {
    contact: contact ? {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      company: contact.company,
      type: contact.type,
      status: contact.status,
    } : null,
    intelligence: intelligence ? {
      stage: intelligence.stage,
      ai_score: intelligence.aiScore,
      ai_score_reason: intelligence.aiScoreReason,
      personality_notes: intelligence.personalityNotes,
    } : null,
    last_brief: brief ? {
      brief_text: brief.briefText,
      generated_at: brief.generatedAt,
    } : null,
    recent_communications: recentComms.map(c => ({
      channel: c.channel,
      direction: c.direction,
      summary: c.summary,
      logged_at: c.loggedAt,
    })),
    ai_output_snapshot: extra?.aiOutput || null,
    extra: extra || null,
  };
}
