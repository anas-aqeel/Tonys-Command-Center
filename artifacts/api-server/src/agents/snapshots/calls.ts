// Calls feedback snapshot — for follow-up draft thumbs / edit feedback.

import { sharedDb, callLogTable, contactsTable, contactIntelligenceTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function captureCallsSnapshot(
  skill: string,
  sourceId: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let call: any = null;
  let contact: any = null;
  let intelligence: any = null;
  let recentCallsToContact: any[] = [];

  if (sourceId && /^[0-9a-f-]{36}$/i.test(sourceId)) {
    const [c] = await sharedDb.select().from(callLogTable)
      .where(eq(callLogTable.id, sourceId))
      .limit(1);
    call = c || null;

    if (call?.contactName) {
      const [con] = await sharedDb.select().from(contactsTable)
        .where(eq(contactsTable.name, call.contactName))
        .limit(1);
      contact = con || null;
      if (contact?.id) {
        const [i] = await sharedDb.select().from(contactIntelligenceTable)
          .where(eq(contactIntelligenceTable.contactId, contact.id))
          .limit(1);
        intelligence = i || null;

        recentCallsToContact = await sharedDb.select({
          type: callLogTable.type,
          notes: callLogTable.notes,
          createdAt: callLogTable.createdAt,
        }).from(callLogTable)
          .where(eq(callLogTable.contactName, call.contactName))
          .orderBy(desc(callLogTable.createdAt))
          .limit(5);
      }
    }
  }

  return {
    call: call ? {
      id: call.id,
      type: call.type,
      contact_name: call.contactName,
      notes: call.notes,
      created_at: call.createdAt,
    } : null,
    contact: contact ? {
      id: contact.id,
      type: contact.type,
      pipeline_stage: intelligence?.stage,
    } : null,
    recent_calls_to_contact: recentCallsToContact,
    ai_draft_snapshot: extra?.aiDraft || null,
    user_edit: extra?.userEdit || null,
    extra: extra || null,
  };
}
