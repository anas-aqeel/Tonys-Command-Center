import { Router, type IRouter } from "express";
import { sharedDb, phoneLogTable, contactsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { communicationLogTable } from "../../lib/schema-v2";
import { updateContactComms } from "../../lib/contact-comms";

const router: IRouter = Router();

const SendSmsBody = z.object({
  phone_number: z.string().min(1, "phone_number is required"),
  message: z.string().min(1, "message is required"),
  contact_id: z.string().optional(),
});

// ─── POST /send-sms — triggers MacroDroid to send SMS from Tony's phone ───────
router.post("/send-sms", async (req, res): Promise<void> => {
  const parsed = SendSmsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { phone_number, message, contact_id } = parsed.data;

  const webhookUrl = process.env.MACRODROID_WEBHOOK_URL;
  const validWebhookUrl = webhookUrl && webhookUrl.startsWith("https://trigger.macrodroid.com/")
    ? webhookUrl
    : null;

  if (!webhookUrl) {
    console.warn("[send-sms] MACRODROID_WEBHOOK_URL env var is NOT SET — SMS will be logged but never sent. Set this in Vercel project settings.");
  } else if (!validWebhookUrl) {
    console.warn(`[send-sms] MACRODROID_WEBHOOK_URL does not start with https://trigger.macrodroid.com/ — current value starts with: ${webhookUrl.slice(0, 40)}...`);
  }

  // B8 (Tony's 2026-05-16): track triggered separately from status so the FE
  // can show "the URL fired but returned non-2xx" vs "the URL never fired".
  let macrodroidOk = false;
  let webhookStatus: number | null = null;
  if (validWebhookUrl) {
    try {
      const resp = await fetch(validWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number, message }),
        signal: AbortSignal.timeout(8000),
      });
      webhookStatus = resp.status;
      macrodroidOk = resp.ok;
      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => "");
        console.warn(`[send-sms] MacroDroid webhook returned ${resp.status}. Body (truncated): ${bodyText.slice(0, 200)}`);
      }
    } catch (err) {
      console.error("[send-sms] MacroDroid webhook error:", err instanceof Error ? err.message : err);
      macrodroidOk = false;
    }
  }

  // Resolve contact name if contact_id given
  let contactName: string | undefined;
  if (contact_id) {
    const [c] = await sharedDb.select({ name: contactsTable.name }).from(contactsTable).where(eq(contactsTable.id, contact_id));
    contactName = c?.name;
  }

  // Log the outbound SMS
  const [entry] = await sharedDb
    .insert(phoneLogTable)
    .values({
      phoneNumber: phone_number,
      type: "sms_outbound",
      contactId: contact_id ?? undefined,
      contactName: contactName ?? undefined,
      smsBody: message,
      matched: !!contact_id,
      loggedAt: new Date(),
    })
    .returning();

  await sharedDb.insert(communicationLogTable).values({
    contactId: contact_id ?? undefined,
    contactName: contactName ?? phone_number,
    channel: "text_sent",
    direction: "outbound",
    summary: message.substring(0, 300),
  }).catch(err => console.warn("[send-sms] comm_log insert failed:", err));

  if (contact_id) {
    updateContactComms(contact_id, "text_sent", message).catch(() => {});
  }

  res.status(201).json({
    sent: true,
    macrodroid_triggered: macrodroidOk,
    macrodroid_configured: !!validWebhookUrl,
    macrodroid_status: webhookStatus,
    log_id: entry.id,
  });
});

export default router;
