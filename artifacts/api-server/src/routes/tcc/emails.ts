import { Router, type IRouter } from "express";
import { eq, desc, and, or, gt, isNull } from "drizzle-orm";
import { db, emailTrainingTable, emailSnoozesTable, systemInstructionsTable } from "@workspace/db";
import { EmailActionBody } from "@workspace/api-zod";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { sendEmail } from "../../lib/gmail.js";
import { getGmail } from "../../lib/google-auth.js";
import { todayPacific } from "../../lib/dates.js";
import { recordFeedback } from "../../agents/feedback.js";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";
import { substituteContactTokens } from "../../lib/contact-tokens.js";

const router: IRouter = Router();

// Brain regeneration moved to Coach + Train-button flow (see Phase 6 plan).
// Every thumbs feedback writes to agent_feedback; Tony reviews and clicks Train
// to fire Coach which proposes an updated brain (kind='memory', section='rules').
// The legacy auto-fire-on-20-samples path was removed in Phase 7 C12.

// Parse the snooze label sent by the frontend ("1h" / "2h" / "tom" /
// YYYY-MM-DD) into an absolute expiry timestamp. Returns null when the
// label can't be parsed — caller falls back to the legacy date-rollover
// behaviour (snooze hides the email until the next Pacific day).
function snoozeLabelToExpiry(label: string): Date | null {
  if (!label) return null;
  if (label === "1h") return new Date(Date.now() + 60 * 60 * 1000);
  if (label === "2h") return new Date(Date.now() + 2 * 60 * 60 * 1000);
  // YYYY-MM-DD: re-show on that day at 5am Pacific. Pacific is UTC-7 (PDT)
  // most of the year; PST is UTC-8 in winter. Anchor the timestamp at the
  // chosen day at 12:00 UTC which is 4-5am Pacific — close enough for the
  // "show me first thing on this day" intent.
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    const [y, m, d] = label.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  }
  // "tom" → tomorrow at 12:00 UTC (~5am Pacific). Equivalent to date rollover.
  if (label === "tom" || label === "tomorrow") {
    const t = new Date();
    t.setUTCDate(t.getUTCDate() + 1);
    t.setUTCHours(12, 0, 0, 0);
    return t;
  }
  return null;
}

// ─── GET brain ────────────────────────────────────────────────────────────────
router.get("/emails/brain", async (req, res): Promise<void> => {
  const [row] = await db
    .select()
    .from(systemInstructionsTable)
    .where(eq(systemInstructionsTable.section, "email_brain"));

  const training = await db
    .select()
    .from(emailTrainingTable)
    .orderBy(desc(emailTrainingTable.createdAt))
    .limit(50);

  res.json({
    brain: row?.content || null,
    updatedAt: row?.updatedAt || null,
    trainingCount: training.length,
    recentTraining: training.slice(0, 10),
  });
});

// ─── GET snoozed ─────────────────────────────────────────────────────────────
// Returns the active snooze map. A row is "active" when:
//   - expires_at is in the future, OR
//   - expires_at is null AND the row was created today (legacy date-rollover)
router.get("/emails/snoozed", async (req, res): Promise<void> => {
  const today = todayPacific();
  const now = new Date();
  const snoozes = await db
    .select()
    .from(emailSnoozesTable)
    .where(or(
      gt(emailSnoozesTable.expiresAt, now),
      and(isNull(emailSnoozesTable.expiresAt), eq(emailSnoozesTable.date, today)),
    ));

  const snoozed: Record<number, string> = {};
  for (const s of snoozes) {
    snoozed[s.emailId] = s.snoozeUntil;
  }
  res.json(snoozed);
});

// ─── POST action ─────────────────────────────────────────────────────────────
router.post("/emails/action", async (req, res): Promise<void> => {
  const parsed = EmailActionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { action, emailId, sender, subject, reason, snoozeUntil } = parsed.data;

  if (action === "thumbs_up" || action === "thumbs_down") {
    await db.insert(emailTrainingTable).values({
      sender: sender || "unknown",
      subject: subject || "",
      action,
      reason: reason || null,
    });

    // New universal feedback capture (no-op when FEEDBACK_PIPELINE_ENABLED=false).
    // Runs alongside the legacy email_training write during transition.
    // Awaited (was fire-and-forget) so the FE gets feedback_id back in the
    // response — the toast action uses it to deep-link into the Train page
    // with this exact row pre-selected.
    let feedbackId: string | undefined;
    try {
      const fb = await recordFeedback({
        agent: "email",
        skill: "triage.classifyBatch",
        sourceType: "thumbs",
        sourceId: String(emailId || sender || "unknown"),
        rating: action === "thumbs_up" ? 1 : -1,
        reviewText: reason || null,
        snapshotExtra: { senderEmail: sender, subject, body: reason },
      });
      feedbackId = fb.feedbackId;
    } catch (err) { console.error("[emails] recordFeedback failed:", err); }

    // Brain regeneration moved to Coach Train button (Phase 6 onwards):
    // every thumbs feedback writes to agent_feedback (above), and Tony reviews
    // patterns + clicks Train to fire Coach. Auto-fire-on-threshold removed.
    const countResult = await db.select().from(emailTrainingTable);
    const totalSamples = countResult.length;
    res.json({ ok: true, feedback_id: feedbackId, message: `Training saved (${totalSamples} samples — review via Train button on Email agent settings)` });
    return;
  }

  if (action === "snooze") {
    if (emailId !== null && emailId !== undefined) {
      const today = todayPacific();
      const label = snoozeUntil || "tomorrow";
      const expiresAt = snoozeLabelToExpiry(label);
      await db
        .insert(emailSnoozesTable)
        .values({ date: today, emailId, snoozeUntil: label, expiresAt })
        .onConflictDoUpdate({
          target: [emailSnoozesTable.date, emailSnoozesTable.emailId],
          set: { snoozeUntil: label, expiresAt },
        });
    }
    res.json({ ok: true, message: `Email ${emailId} snoozed` });
    return;
  }

  if (action === "fetch_thread") {
    const { gmailMessageId } = parsed.data;
    if (!gmailMessageId) {
      res.json({ ok: true, snippet: null, body: null, threadId: null });
      return;
    }
    try {
      const gmail = await getGmail();
      const msg = await gmail.users.messages.get({ userId: "me", id: gmailMessageId, format: "full" });
      const data = msg.data;
      const threadId = data.threadId || null;
      const snippet = data.snippet || null;

      // Decode the email body (text/plain preferred, fallback to text/html stripped)
      function decodeBase64Url(str: string): string {
        return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
      }
      function extractBody(payload: typeof data.payload): string {
        if (!payload) return "";
        if (payload.mimeType === "text/plain" && payload.body?.data) {
          return decodeBase64Url(payload.body.data);
        }
        if (payload.parts) {
          for (const part of payload.parts) {
            if (part.mimeType === "text/plain" && part.body?.data) {
              return decodeBase64Url(part.body.data);
            }
          }
          for (const part of payload.parts) {
            const sub = extractBody(part as typeof payload);
            if (sub) return sub;
          }
        }
        if (payload.body?.data) return decodeBase64Url(payload.body.data);
        return "";
      }

      const rawBody = extractBody(data.payload);
      // Trim to first 1500 chars and strip quoted lines (lines starting with >)
      const body = rawBody
        .split("\n")
        .filter(l => !l.trimStart().startsWith(">"))
        .join("\n")
        .trim()
        .substring(0, 1500);

      res.json({ ok: true, snippet, body: body || snippet, threadId });
    } catch (err) {
      req.log.warn({ err }, "fetch_thread failed");
      res.json({ ok: true, snippet: null, body: null, threadId: null });
    }
    return;
  }

  if (action === "suggest_reply") {
    // Load the email brain to inform the reply
    const [brainRow] = await db
      .select()
      .from(systemInstructionsTable)
      .where(eq(systemInstructionsTable.section, "email_brain"));

    const brainContext = brainRow?.content
      ? `\n\nTONY'S EMAIL BRAIN (learned from his training):\n${brainRow.content}`
      : "";

    const { notes, gmailMessageId } = parsed.data;

    // Fetch the actual email body from Gmail. The previous version sent only
    // sender + subject — the AI had no idea what the email said and either
    // produced a generic reply or asked for the body. Now we fetch the full
    // text/plain body (with quoted lines stripped, capped at 1500 chars).
    let emailBody = "";
    if (gmailMessageId) {
      try {
        const gmail = await getGmail();
        const msg = await gmail.users.messages.get({ userId: "me", id: gmailMessageId, format: "full" });
        const data = msg.data;
        const decode = (str: string) =>
          Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
        const extract = (payload: typeof data.payload): string => {
          if (!payload) return "";
          if (payload.mimeType === "text/plain" && payload.body?.data) return decode(payload.body.data);
          if (payload.parts) {
            for (const part of payload.parts) {
              if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
            }
            for (const part of payload.parts) {
              const sub = extract(part as typeof payload);
              if (sub) return sub;
            }
          }
          if (payload.body?.data) return decode(payload.body.data);
          return "";
        };
        const raw = extract(data.payload);
        emailBody = raw
          .split("\n")
          .filter(l => !l.trimStart().startsWith(">"))
          .join("\n")
          .trim()
          .substring(0, 1500);
        if (!emailBody) emailBody = data.snippet || "";
      } catch (err) {
        req.log.warn({ err, gmailMessageId }, "Failed to fetch email body for suggest_reply");
      }
    }

    let draft = "";
    // First-name extraction for B6 token sanitation. `sender` typically looks
    // like a display name ("Drew Wolfe") — split on whitespace.
    const senderFirstName = (sender || "").split(/\s+/)[0] || sender || "there";
    try {
      let rawText = "";

      // Flag-gated: AGENT_RUNTIME_EMAIL=true routes through runtime;
      // default false keeps legacy inline prompt + brain context.
      if (isAgentRuntimeEnabled("email")) {
        // Runtime path: send only dynamic data — voice/format instructions live
        // in the skill body. Brain content stays in the user message because
        // email-brain → memory-section migration lands in a later phase.
        const runtimeMessage = `From: ${sender} (first name: ${senderFirstName})
Subject: ${subject}
${emailBody ? `\nORIGINAL EMAIL:\n${emailBody}` : "\n(No email body available — draft a generic professional reply based on the subject line.)"}
${reason ? `\nWhy this is important: ${reason}` : ""}
${notes ? `\nTony's notes: ${notes}` : ""}${brainContext
  ? `\n\nTONY'S EMAIL BRAIN (learned from training):\n${brainRow?.content || ""}`
  : ""}

Address the sender as ${senderFirstName} — never use placeholder tokens like {firstName} or {name}.`;

        const result = await runAgent("email", "reply-draft", {
          userMessage: runtimeMessage,
          caller: "direct",
          meta: { sender, subject, hasBody: !!emailBody, hasReason: !!reason, hasNotes: !!notes },
        });
        rawText = result.text;
      } else {
        const userMessage = `Draft a reply to this email:
From: ${sender} (first name: ${senderFirstName})
Subject: ${subject}
${emailBody ? `\nORIGINAL EMAIL:\n${emailBody}` : "\n(No email body available — draft a generic professional reply based on the subject line.)"}
${reason ? `\nContext: ${reason}` : ""}
${notes ? `\nAdditional notes from Tony: ${notes}` : ""}

Write a professional reply from Tony Diaz. Keep it brief and action-oriented. Plain text only. Output ONLY the reply text — no preamble, no "here's a draft", no explanation. Start directly with the salutation. Address the sender as ${senderFirstName} — never use placeholder tokens like {firstName} or {name}.`;
        const message = await createTrackedMessage("email_action", {
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          system: `You are Tony Diaz's AI assistant. Tony runs FlipIQ, a real estate wholesale platform.
Draft professional, concise email replies in Tony's voice — direct, warm, action-oriented.
Keep replies short (3-5 sentences max). Always end with a clear next step.
IMPORTANT: Write in plain prose only. No markdown, no asterisks, no bullet points, no headers, no bold, no formatting characters whatsoever. Just plain text paragraphs.
CRITICAL: Output ONLY the email reply text. Never preface with "Here is your reply" or "I'd be happy to help" or any meta-commentary. Start directly with the salutation. The text you produce will be sent verbatim — anything you say that isn't the email itself will end up in the recipient's inbox.${brainContext}`,
          messages: [{
            role: "user",
            content: userMessage,
          }],
        });
        const block = message.content[0];
        if (block.type === "text") rawText = block.text;
      }

      draft = rawText.replace(/\*\*/g, "").replace(/\*/g, "").replace(/^#+\s/gm, "").replace(/^-\s/gm, "").trim();
      // Strip common AI preambles at the start (defense-in-depth — the skill
      // body forbids these, but Sonnet still slips them in occasionally).
      draft = draft.replace(/^(here(?:'s| is) (?:your |a |the )?(?:draft|reply|response)[^\n]*\n+)/i, "");
      draft = draft.replace(/^(sure[,!]?\s+)?(here(?:'s| is)[^\n]*\n+)/i, "");
      draft = draft.replace(/^(i'?d be happy to help[^\n]*\n+)/i, "");
      draft = draft.trim();
      // B6 safety net: replace any placeholder tokens that slipped through.
      draft = substituteContactTokens(draft, { name: sender || senderFirstName, firstName: senderFirstName });
    } catch (err) {
      req.log.warn({ err }, "Claude API failed for email reply");
      draft = `Hi ${senderFirstName},\n\nThanks for reaching out. Let's connect to discuss this further.\n\nBest,\nTony`;
    }
    res.json({ ok: true, draft });
    return;
  }

  if (action === "send_reply") {
    const { sender, subject, body, gmailMessageId } = parsed.data;
    if (!sender || !subject || !body) {
      res.status(400).json({ ok: false, error: "sender, subject, and body are required" });
      return;
    }
    if (!gmailMessageId) {
      res.status(400).json({ ok: false, error: "gmailMessageId is required to send a reply" });
      return;
    }

    // Resolve recipient address + thread from the original Gmail message.
    // EmailItem.from is just the display name (brief.ts strips the address),
    // so we read the real "From" header off the source message instead.
    let toEmail: string | null = null;
    let threadId: string | undefined;
    try {
      const gmail = await getGmail();
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: gmailMessageId,
        format: "metadata",
        metadataHeaders: ["From"],
      });
      threadId = msg.data.threadId || undefined;
      const fromHeader = msg.data.payload?.headers?.find(h => h.name === "From")?.value || "";
      const bracket = fromHeader.match(/<([^>]+)>/);
      if (bracket) toEmail = bracket[1];
      else if (/^[^\s@]+@[^\s@]+$/.test(fromHeader.trim())) toEmail = fromHeader.trim();
    } catch (err) {
      req.log.warn({ err }, "Could not fetch original message for send_reply");
      res.status(400).json({ ok: false, error: "Could not fetch original message to resolve recipient" });
      return;
    }

    if (!toEmail) {
      res.status(400).json({ ok: false, error: "Could not determine recipient email address" });
      return;
    }

    // Append Tony's signature
    const signature = "\n\nTony Diaz\nCEO, FlipIQ";
    const fullBody = body.trimEnd() + signature;

    const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
    const result = await sendEmail({ to: toEmail, subject: replySubject, body: fullBody, threadId });
    res.json(result);
    return;
  }

  res.json({ ok: true, message: "Action processed" });
});

// ─── POST /emails/rewrite — clean up a draft OR generate from a prompt ──────
// Dual-purpose: the same skill handles both because the user picks behavior
// implicitly via what they typed (a salutation+body = rewrite; an instruction
// = generate). The skill body auto-detects.
//
// Body: { text, recipientName?, recipientEmail?, threadSnippet? }
// Returns: { ok, text } where text is paste-ready (no preamble).
router.post("/emails/rewrite", async (req, res): Promise<void> => {
  const { text, recipientName, recipientEmail, threadSnippet } = req.body as {
    text?: string;
    recipientName?: string;
    recipientEmail?: string;
    threadSnippet?: string;
  };

  if (!text || !text.trim()) {
    res.status(400).json({ ok: false, error: "text is required" });
    return;
  }

  // B6: derive a first name for token-sanitation. Prefer recipientName; fall
  // back to the local-part of the email address.
  const recipientFirstName = (recipientName || recipientEmail?.split("@")[0] || "").split(/\s+/)[0] || recipientName || "there";

  // Build the context block. Each field is optional — the skill handles
  // missing context by writing a generic-but-on-topic email (per its rules).
  const ctxLines: string[] = [];
  if (recipientName) ctxLines.push(`Recipient name: ${recipientName} (first name: ${recipientFirstName})`);
  if (recipientEmail) ctxLines.push(`Recipient email: ${recipientEmail}`);
  if (threadSnippet) {
    const trimmed = threadSnippet.length > 1500 ? threadSnippet.slice(0, 1500) + "..." : threadSnippet;
    ctxLines.push(`\nThread snippet (last message in conversation):\n${trimmed}`);
  }
  ctxLines.push(`\nAddress the recipient as ${recipientFirstName} — never use placeholder tokens like {firstName} or {name}.`);

  const userMessage = ctxLines.length
    ? `${ctxLines.join("\n")}\n\n---\n\nUSER INPUT TO REWRITE OR USE AS PROMPT:\n${text.trim()}`
    : `USER INPUT TO REWRITE OR USE AS PROMPT:\n${text.trim()}`;

  try {
    if (isAgentRuntimeEnabled("email")) {
      const result = await runAgent("email", "rewrite", {
        userMessage,
        caller: "direct",
        meta: { hasRecipient: !!recipientEmail, hasThread: !!threadSnippet },
      });
      let cleaned = (result.text || "").trim()
        .replace(/^```(?:text|markdown)?\s*\n?/i, "")
        .replace(/\n?```\s*$/, "")
        .trim();
      cleaned = substituteContactTokens(cleaned, { name: recipientName || recipientFirstName, firstName: recipientFirstName });
      res.json({ ok: true, text: cleaned });
      return;
    }

    // Legacy path — single inline call when runtime flag is off.
    const legacySystem = `You are Tony Diaz's AI email assistant. Tony runs FlipIQ (real estate wholesaling). Output ONLY the email body. No preamble. No "Here's the rewritten version". No markdown. Start with the salutation. Auto-detect: input may be a draft to clean up OR an instruction like "write to X about Y" — both produce a clean paste-ready email body in Tony's voice. End with "Tony" as the sign-off. NEVER write placeholder tokens like {firstName} or {name} — always use the recipient's real name.`;
    const msg = await createTrackedMessage("agent_email_rewrite", {
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: legacySystem,
      messages: [{ role: "user", content: userMessage }],
    });
    const block = msg.content.find(b => b.type === "text");
    let out = (block?.type === "text" ? block.text : "").trim()
      .replace(/^```(?:text|markdown)?\s*\n?/i, "")
      .replace(/\n?```\s*$/, "")
      .trim();
    out = substituteContactTokens(out, { name: recipientName || recipientFirstName, firstName: recipientFirstName });
    res.json({ ok: true, text: out });
  } catch (err) {
    req.log.error({ err }, "[/emails/rewrite] failed");
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
