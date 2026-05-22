import { Router, type IRouter } from "express";
import { db, callLogTable, contactsTable } from "@workspace/db";
import { LogCallBody } from "@workspace/api-zod";
import { gte, eq, sql } from "drizzle-orm";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { z } from "zod";
import { communicationLogTable, contactIntelligenceTable } from "../../lib/schema-v2";
import { createReminder } from "../../lib/gcal";
import { updateContactComms } from "../../lib/contact-comms";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";
import { substituteContactTokens } from "../../lib/contact-tokens.js";

const router: IRouter = Router();

router.get("/calls", async (req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const calls = await db
    .select()
    .from(callLogTable)
    .where(gte(callLogTable.createdAt, today));

  res.json(calls);
});

router.post("/calls", async (req, res): Promise<void> => {
  const parsed = LogCallBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { contactId, contactName, type, notes } = parsed.data;
  const instructions = (req.body as Record<string, unknown>).instructions as string | undefined;

  const [call] = await db
    .insert(callLogTable)
    .values({
      contactId: contactId ?? undefined,
      contactName,
      type,
      notes: notes ?? undefined,
    })
    .returning();

  // Always log to communication_log when we have a contactId
  if (contactId) {
    await db.insert(communicationLogTable).values({
      contactId,
      contactName,
      channel: "call_outbound",
      direction: "outbound",
      subject: type === "attempt" ? "Call attempt" : "Connected call",
      summary: notes || (type === "attempt" ? "No answer" : "Connected"),
    }).catch(err => console.warn("[calls] Failed to log to communication_log:", err));

    updateContactComms(contactId, "call_outbound", notes || type).catch(() => {});
  }

  if (type === "attempt" && instructions) {
    try {
      let draftText: string | undefined;
      // Tony's 2026-05-16 ask: use the contact's actual first name; no
      // placeholder tokens. Inject the firstName into the prompt + sanitize
      // any leaks via substituteContactTokens at the bottom.
      const firstName = contactName.split(/\s+/)[0];

      // Flag-gated: AGENT_RUNTIME_CALLS=true routes through the new agent
      // runtime; default false keeps the legacy inline prompt intact.
      // Runtime path sends only dynamic data; voice/format rules in skill body.
      if (isAgentRuntimeEnabled("calls")) {
        const runtimeMessage = `Call attempt — ${contactName} (first name: ${firstName}, no answer).
Tony's instructions: "${instructions}"

Use the contact's actual first name (${firstName}) in the greeting. Do NOT use placeholder tokens like {firstName}, {name}, or {fullName} — write the real name directly.`;

        const result = await runAgent("calls", "follow-up-draft", {
          userMessage: runtimeMessage,
          caller: "direct",
          meta: { contactName, callType: type, callId: call.id },
        });
        draftText = result.text.trim() || undefined;
      } else {
        const msg = await createTrackedMessage("call_follow_up", {
          model: "claude-haiku-4-5",
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: `Tony Diaz (FlipIQ CEO) tried to call ${contactName} but got no answer.
Tony's instructions: "${instructions}"
Draft a brief, professional follow-up email (3-4 sentences max). Plain text only, no subject line. Use the contact's actual first name (${firstName}) in the greeting — never write placeholder tokens like {firstName} or {name}.`,
            },
          ],
        });
        draftText = msg.content.find(b => b.type === "text")?.text?.trim();
      }

      // Safety net: strip any placeholder tokens that slipped through (B6).
      draftText = draftText ? substituteContactTokens(draftText, { name: contactName }) : undefined;

      if (draftText) {
        const [updated] = await db.update(callLogTable)
          .set({ followUpText: draftText, followUpSent: false })
          .where(eq(callLogTable.id, call.id))
          .returning();
        res.status(201).json(updated ?? call);
        return;
      }
    } catch (err) {
      req.log.warn({ err }, "Claude follow-up email failed");
    }
  }

  res.status(201).json(call);
});

const ConnectedCallBody = z.object({
  contactId: z.string().uuid(),
  contactName: z.string(),
  outcomeNotes: z.string().min(1),
  nextStep: z.string().optional(),
  followUpDate: z.string().optional(),
});

router.post("/calls/connected-outcome", async (req, res): Promise<void> => {
  const parsed = ConnectedCallBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { contactId, contactName, outcomeNotes, nextStep, followUpDate } = parsed.data;

  try {
    await db.insert(communicationLogTable).values({
      contactId,
      contactName,
      channel: "call_outbound",
      direction: "outbound",
      subject: "Connected call",
      summary: outcomeNotes.substring(0, 300),
      fullContent: [outcomeNotes, nextStep ? `Next step: ${nextStep}` : ""].filter(Boolean).join("\n"),
    });

    if (followUpDate) {
      const nextActionText = nextStep || `Follow up with ${contactName}`;

      await db.execute(sql`
        INSERT INTO contact_intelligence (id, contact_id, next_action, next_action_date, updated_at)
        VALUES (gen_random_uuid(), ${contactId}, ${nextActionText}, ${followUpDate}, NOW())
        ON CONFLICT (contact_id) DO UPDATE SET
          next_action = ${nextActionText},
          next_action_date = ${followUpDate},
          updated_at = NOW()
      `);

      await createReminder({
        summary: `Follow up: ${contactName}`,
        date: followUpDate,
        description: `${outcomeNotes}\n\nNext step: ${nextStep || "Follow up"}`,
      });
    }

    // Generate an AI follow-up draft using the call outcome so the email-compose
    // modal opens prefilled (Tony's 2026-05-16 feedback: "make sure this
    // information is preloaded so I don't have to come back and refill it").
    // Best-effort — if the draft fails, the route still returns ok with no draft.
    let followUpText: string | null = null;
    try {
      const firstName = contactName.split(/\s+/)[0];
      const runtimeMessage = `Connected call with ${contactName} (first name: ${firstName}).

Outcome notes: ${outcomeNotes}
${nextStep ? `Next step: ${nextStep}` : ""}
${followUpDate ? `Follow-up date: ${followUpDate}` : ""}

Draft a short follow-up email recapping the call and confirming the next step. Use the contact's actual first name (${firstName}) — NEVER write placeholder tokens like {firstName} or {name}. Plain text only, no subject line, no signature (Tony's email signature is appended automatically).`;

      if (isAgentRuntimeEnabled("calls")) {
        const result = await runAgent("calls", "follow-up-draft", {
          userMessage: runtimeMessage,
          caller: "direct",
          meta: { contactName, callType: "connected", contactId },
        });
        followUpText = result.text.trim() || null;
      } else {
        const msg = await createTrackedMessage("call_connected_follow_up", {
          model: "claude-haiku-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: runtimeMessage }],
        });
        const block = msg.content.find(b => b.type === "text");
        followUpText = (block?.type === "text" ? block.text.trim() : null) || null;
      }

      // Defense in depth: strip any placeholder tokens that slipped through (B6).
      followUpText = followUpText ? substituteContactTokens(followUpText, { name: contactName, firstName }) : null;
    } catch (err) {
      req.log.warn({ err }, "Connected-call follow-up draft generation failed");
    }

    res.json({ ok: true, followUpText });
  } catch (err) {
    req.log.error({ err }, "Connected call outcome logging failed");
    res.status(500).json({ error: "Failed to log connected call outcome" });
  }
});

export default router;
