import { Router, type IRouter } from "express";
import { sharedDb, phoneLogTable, contactsTable } from "@workspace/db";
import { eq, desc, gte, and } from "drizzle-orm";
import { z } from "zod/v4";
import { communicationLogTable, contactIntelligenceTable } from "../../lib/schema-v2";
import { updateContactComms } from "../../lib/contact-comms";

const router: IRouter = Router();

const VALID_TYPES = ["call_outbound", "call_inbound", "sms_outbound", "sms_inbound"] as const;
type PhoneLogType = typeof VALID_TYPES[number];

const PhoneLogBody = z.object({
  type: z.enum(VALID_TYPES),
  phone_number: z.string().min(1, "phone_number is required"),
  duration_seconds: z.number().optional(),
  sms_body: z.string().optional(),
  logged_at: z.string().optional(),
  flipiq_tagged: z.boolean().optional(),
});

// ─── Shared secret check ──────────────────────────────────────────────────────
function checkSecret(req: import("express").Request, res: import("express").Response): boolean {
  const secret = req.query["key"] as string | undefined;
  const expected = process.env.MACRODROID_SECRET;
  if (!expected) { res.status(401).json({ error: "MACRODROID_SECRET not configured" }); return false; }
  if (secret !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

// ─── Strip non-digits for phone matching ─────────────────────────────────────
function normalizePhone(p: string): string {
  return p.replace(/\D/g, "");
}

// ─── Shared handler for MacroDroid webhook body ───────────────────────────────
async function handlePhoneLogWebhook(
  req: import("express").Request,
  res: import("express").Response,
): Promise<void> {
  const parsed = PhoneLogBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { type, phone_number, duration_seconds, sms_body, logged_at, flipiq_tagged } = parsed.data;
  const normalizedIncoming = normalizePhone(phone_number);

  // Auto-match to contact via indexed phone_normalized column
  let [match] = await sharedDb
    .select({ id: contactsTable.id, name: contactsTable.name })
    .from(contactsTable)
    .where(eq(contactsTable.phoneNormalized, normalizedIncoming))
    .limit(1);

  // FlipIQ auto-contact creation: if tagged and no match, create a new contact + intelligence row
  if (flipiq_tagged && !match) {
    const autoName = `Unknown — (${phone_number})`;
    const [newContact] = await sharedDb
      .insert(contactsTable)
      .values({ name: autoName, phone: phone_number, source: "phone", status: "New" })
      .returning({ id: contactsTable.id, name: contactsTable.name });
    if (newContact) {
      match = newContact;
      await sharedDb.insert(contactIntelligenceTable).values({ contactId: newContact.id }).onConflictDoNothing();
    }
  }

  const [entry] = await sharedDb
    .insert(phoneLogTable)
    .values({
      phoneNumber: phone_number,
      type,
      contactId: match?.id ?? undefined,
      contactName: match?.name ?? undefined,
      durationSeconds: duration_seconds ?? undefined,
      smsBody: sms_body ?? undefined,
      matched: !!match,
      loggedAt: logged_at ? new Date(logged_at) : new Date(),
    })
    .returning();

  // Update contact's lastContactDate if matched
  if (match) {
    await sharedDb
      .update(contactsTable)
      .set({ lastContactDate: new Date().toISOString().split("T")[0], updatedAt: new Date() })
      .where(eq(contactsTable.id, match.id))
      .catch(err => console.error("[phone-log] Failed to update lastContactDate:", err));
  }

  // Mirror to communication_log and update contact intelligence
  const channelMap: Record<string, string> = {
    call_outbound: "call_outbound",
    call_inbound: "call_inbound",
    sms_outbound: "text_sent",
    sms_inbound: "text_received",
  };
  const channel = channelMap[type] || type;
  const direction = type.endsWith("_outbound") ? "outbound" : "inbound";

  await sharedDb.insert(communicationLogTable).values({
    contactId: match?.id ?? undefined,
    contactName: match?.name ?? phone_number,
    channel,
    direction,
    summary: sms_body ? sms_body.substring(0, 300) : (duration_seconds ? `${Math.round(duration_seconds / 60)} min call` : type),
  }).catch(err => console.warn("[phone-log] comm_log insert failed:", err));

  if (match?.id) {
    updateContactComms(match.id, channel, sms_body || type).catch(() => {});
  }

  res.status(201).json({ logged: true, matched: entry.matched, contact_name: entry.contactName ?? null });
}

// ─── Webhook: MacroDroid → POST /phone-log?key=secret ────────────────────────
router.post("/phone-log", async (req, res): Promise<void> => {
  if (!checkSecret(req, res)) return;
  await handlePhoneLogWebhook(req, res);
});

// ─── Alias: POST /phone-log/incoming?key=secret (same webhook, alternate path) ─
router.post("/phone-log/incoming", async (req, res): Promise<void> => {
  if (!checkSecret(req, res)) return;
  await handlePhoneLogWebhook(req, res);
});

// ─── GET /phone-log?contactId=xxx — for contact activity feed ────────────────
router.get("/phone-log", async (req, res): Promise<void> => {
  const contactId = req.query["contactId"] as string | undefined;
  const since = req.query["since"] as string | undefined;

  let query = sharedDb.select().from(phoneLogTable).$dynamic();

  if (contactId && since) {
    query = query.where(and(eq(phoneLogTable.contactId, contactId), gte(phoneLogTable.loggedAt, new Date(since))));
  } else if (contactId) {
    query = query.where(eq(phoneLogTable.contactId, contactId));
  } else if (since) {
    query = query.where(gte(phoneLogTable.loggedAt, new Date(since)));
  }

  const logs = await query.orderBy(desc(phoneLogTable.loggedAt)).limit(50);
  res.json(logs);
});

// ─── GET /phone-log/today — all phone activity today ─────────────────────────
router.get("/phone-log/today", async (req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const logs = await sharedDb
    .select()
    .from(phoneLogTable)
    .where(gte(phoneLogTable.loggedAt, today))
    .orderBy(desc(phoneLogTable.loggedAt));

  res.json(logs);
});

export default router;
