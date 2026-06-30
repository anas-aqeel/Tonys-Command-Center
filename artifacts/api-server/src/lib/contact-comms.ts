import { sharedDb, contactsTable } from "@workspace/db";
import { contactIntelligenceTable } from "./schema-v2";
import { sql, eq } from "drizzle-orm";

export async function updateContactComms(contactId: string, channel: string, summary: string) {
  if (!contactId) return;

  try {
    const counterColumn =
      channel.startsWith("call") ? "total_calls" :
      channel === "email_sent" ? "total_emails_sent" :
      channel === "email_received" ? "total_emails_received" :
      channel.startsWith("text") ? "total_texts" :
      channel === "meeting" ? "total_meetings" : null;

    if (counterColumn) {
      await sharedDb.execute(sql`
        INSERT INTO contact_intelligence (id, contact_id, ${sql.raw(counterColumn)}, last_communication_date, last_communication_type, last_communication_summary, updated_at)
        VALUES (gen_random_uuid(), ${contactId}, 1, NOW(), ${channel}, ${summary.substring(0, 300)}, NOW())
        ON CONFLICT (contact_id) DO UPDATE SET
          ${sql.raw(counterColumn)} = COALESCE(contact_intelligence.${sql.raw(counterColumn)}, 0) + 1,
          last_communication_date = NOW(),
          last_communication_type = ${channel},
          last_communication_summary = ${summary.substring(0, 300)},
          updated_at = NOW()
      `);
    }

    // Also update lastContactDate on the main contacts table
    const todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    await sharedDb.update(contactsTable).set({ lastContactDate: todayPT, updatedAt: new Date() }).where(eq(contactsTable.id, contactId));
  } catch (err) {
    console.warn("[contact-comms] Failed to update contact intelligence:", err);
  }
}
