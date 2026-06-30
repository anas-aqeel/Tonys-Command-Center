// Email feedback snapshot. Captures world-state at the moment Tony reacts to
// an email (thumbs/triage drag/reply edit).
//
// Per FEEDBACK_SYSTEM.md §4.2, email snapshot includes: email body excerpt +
// sender contact (if matched) + comm log last 6 + email_brain at the time +
// special-instructions content + time-of-day. Best-effort — partial is OK.

import { sharedDb, personalDb, contactsTable, systemInstructionsTable, communicationLogTable, contactIntelligenceTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";

export async function captureEmailSnapshot(
  skill: string,
  sourceId: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Caller passes email metadata via `extra` (we don't have a direct email
  // store keyed by gmailMessageId). Snapshot will include whatever was passed.
  const senderEmail = (extra?.senderEmail as string) || (extra?.from as string) || null;
  const subject = (extra?.subject as string) || null;
  const bodyExcerpt = (extra?.bodyExcerpt as string) || (extra?.body as string)?.slice(0, 1000) || null;
  const time = new Date();

  // Look up contact by sender email (if we have one)
  let contact: any = null;
  let intelligence: any = null;
  if (senderEmail) {
    const [c] = await sharedDb.select().from(contactsTable)
      .where(eq(contactsTable.email, senderEmail))
      .limit(1);
    contact = c || null;
    if (c?.id) {
      const [i] = await sharedDb.select().from(contactIntelligenceTable)
        .where(eq(contactIntelligenceTable.contactId, c.id))
        .limit(1);
      intelligence = i || null;
    }
  }

  // Last 6 comm log entries for this contact
  let recentComms: any[] = [];
  if (contact?.id) {
    recentComms = await sharedDb.select().from(communicationLogTable)
      .where(eq(communicationLogTable.contactId, contact.id))
      .orderBy(desc(communicationLogTable.loggedAt))
      .limit(6);
  }

  // Email brain (current learned rules) at the time of feedback
  let emailBrain: string | null = null;
  try {
    const [b] = await personalDb.select().from(systemInstructionsTable)
      .where(eq(systemInstructionsTable.section, "email_brain"))
      .limit(1);
    emailBrain = b?.content || null;
  } catch { /* table may not exist on some envs */ }

  return {
    email: {
      gmail_message_id: sourceId,
      sender_email: senderEmail,
      subject,
      body_excerpt: bodyExcerpt,
    },
    contact: contact ? {
      id: contact.id,
      name: contact.name,
      company: contact.company,
      type: contact.type,
      pipeline_stage: intelligence?.stage,
      ai_score: intelligence?.aiScore,
    } : null,
    recent_communications: recentComms.map(c => ({
      channel: c.channel,
      direction: c.direction,
      subject: c.subject,
      summary: c.summary,
      logged_at: c.loggedAt,
    })),
    email_brain_at_capture: emailBrain,
    time_of_day_pt: time.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour12: true }),
  };
}
