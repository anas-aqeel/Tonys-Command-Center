import { Router, type IRouter } from "express";
import { z } from "zod";
import { getGmail } from "../../lib/google-auth";
import { sharedDb } from "@workspace/db";
import { communicationLogTable, contactsTable } from "../../lib/schema-v2";
import { eq } from "drizzle-orm";
import { updateContactComms } from "../../lib/contact-comms";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";
import { substituteContactTokens } from "../../lib/contact-tokens.js";

const router: IRouter = Router();

// ─── Fetch Gmail signature ─────────────────────────────────────────────────
async function getGmailSignature(): Promise<string> {
  try {
    const gmail = await getGmail();
    const res = await gmail.users.settings.sendAs.list({ userId: "me" });
    const primary = (res.data.sendAs || []).find(s => s.isPrimary);
    const sig = primary?.signature || "";
    // Strip HTML tags to get plain text
    return sig.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
  } catch {
    return `${process.env.TCC_USER_NAME || "Tony Diaz"}\n${process.env.TCC_USER_ROLE || "CEO"}, FlipIQ`;
  }
}

// ─── GET /email/signature ──────────────────────────────────────────────────
router.get("/email/signature", async (_req, res): Promise<void> => {
  const sig = await getGmailSignature();
  res.json({ signature: sig });
});

// ─── POST /email/send ──────────────────────────────────────────────────────
const SendEmailBody = z.object({
  to: z.string().email(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  threadId: z.string().optional(),
  contactId: z.string().uuid().optional(),
  isHtml: z.boolean().optional().default(false),
});

router.post("/email/send", async (req, res): Promise<void> => {
  const parsed = SendEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { to, cc, bcc, subject, body, threadId, contactId, isHtml } = parsed.data;

  try {
    const gmail = await getGmail();

    const contentType = isHtml ? "text/html" : "text/plain";
    const headers = [
      `From: ${process.env.TCC_USER_NAME || "Tony Diaz"} <${process.env.TCC_USER_EMAIL || "tony@flipiq.com"}>`,
      `To: ${to}`,
      cc ? `Cc: ${cc}` : null,
      bcc ? `Bcc: ${bcc}` : null,
      `Subject: ${subject}`,
      `Content-Type: ${contentType}; charset=utf-8`,
    ].filter(h => h !== null).join("\r\n");
    const messageParts = headers + "\r\n\r\n" + body;

    const encoded = Buffer.from(messageParts)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const result = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encoded,
        threadId: threadId || undefined,
      },
    });

    let contactName = to;
    if (contactId) {
      const [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
      if (contact) contactName = contact.name;
    }

    await sharedDb.insert(communicationLogTable).values({
      contactId: contactId || undefined,
      contactName,
      channel: "email_sent",
      direction: "outbound",
      subject,
      summary: body.substring(0, 300),
      fullContent: body,
      gmailMessageId: result.data.id || undefined,
      gmailThreadId: result.data.threadId || undefined,
    });

    if (contactId) {
      updateContactComms(contactId, "email_sent", subject).catch(() => {});
    }

    res.json({
      ok: true,
      messageId: result.data.id,
      threadId: result.data.threadId,
    });
  } catch (err) {
    req.log.error({ err }, "Gmail send failed");
    res.status(500).json({ error: "Failed to send email" });
  }
});

// ─── POST /email/suggest-draft ────────────────────────────────────────────
const SuggestDraftBody = z.object({
  to: z.string(),
  subject: z.string().optional(),
  context: z.string().optional(),
  contactName: z.string().optional(),
  replyToSnippet: z.string().optional(),
});

router.post("/email/suggest-draft", async (req, res): Promise<void> => {
  const parsed = SuggestDraftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { to, subject, context, contactName, replyToSnippet } = parsed.data;

  try {
    const recipient = contactName || to;
    // First name for greetings — derive from contactName, fallback to to-address local part.
    const firstName = (contactName || to.split("@")[0] || recipient).split(/\s+/)[0];

    const userName = process.env.TCC_USER_NAME || "Tony Diaz";
    const userRole = process.env.TCC_USER_ROLE || "CEO";
    const systemPrompt = `You are drafting emails on behalf of ${userName}, ${userRole} of FlipIQ — a real estate wholesaling and investment platform.
${userName}'s writing style: direct, warm, professional, action-oriented. He gets to the point fast and keeps emails short.
Always greet the recipient with their actual first name; NEVER write placeholder tokens like {firstName}, {name}, or {fullName}.
You must respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"subject":"<subject line>","body":"<email body — use \\n for line breaks, do NOT include a signature>"}`;

    const userPrompt = replyToSnippet
      ? `Draft a reply from ${userName} to ${recipient} (first name: ${firstName}).
Original subject: "${subject || "No subject"}"
Original message snippet: "${replyToSnippet}"
${context ? `Additional context: ${context}` : ""}
Keep it 2-4 sentences. Be warm and direct. Address them as ${firstName} — no placeholder tokens.`
      : `Draft an email from ${userName} to ${recipient} (first name: ${firstName}).
${subject ? `Subject hint: "${subject}"` : "Create a clear, compelling subject line."}
${context ? `Context/purpose: ${context}` : "Write a general outreach or follow-up email."}
Keep the body to 3-5 sentences max. Address them as ${firstName} — no placeholder tokens.`;

    let raw = "";

    // Flag-gated: AGENT_RUNTIME_EMAIL=true routes through runtime;
    // default false keeps legacy inline prompt intact.
    if (isAgentRuntimeEnabled("email")) {
      // Runtime path: send only dynamic data — voice/format instructions live in
      // the skill body. v2 compose-new emits prose with a "Subject:" first line
      // by default; this route expects JSON {"subject", "body"}, so spell the
      // contract in the user message instead of relying on the skill default.
      const runtimeMessage = replyToSnippet
        ? `REPLY context. Recipient: ${recipient}\nOriginal subject: "${subject || "No subject"}"\nOriginal snippet: "${replyToSnippet}"${context ? `\nContext: ${context}` : ""}\n\nReturn ONLY JSON: {"subject":"<subject>","body":"<body — use \\n for line breaks, do NOT include a signature>"}`
        : `NEW email. Recipient: ${recipient}${subject ? `\nSubject hint: "${subject}"` : ""}${context ? `\nContext: ${context}` : ""}\n\nReturn ONLY JSON: {"subject":"<subject>","body":"<body — use \\n for line breaks, do NOT include a signature>"}`;

      const result = await runAgent("email", "compose-new", {
        userMessage: runtimeMessage,
        caller: "direct",
        meta: { recipient, hasReplyToSnippet: !!replyToSnippet },
      });
      raw = result.text.trim();
    } else {
      const response = await createTrackedMessage("email_draft", {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
      const textBlock = response.content.find(b => b.type === "text");
      raw = textBlock?.type === "text" ? textBlock.text.trim() : "";
    }

    // Strip markdown code fences if Claude wrapped the JSON in them
    raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

    let draftSubject = subject || "";
    let draftBody = "";

    try {
      const parsed = JSON.parse(raw);
      draftSubject = parsed.subject || draftSubject;
      // Convert literal \n sequences to actual newlines
      draftBody = (parsed.body || "").replace(/\\n/g, "\n");
    } catch {
      // Fallback: try to extract body from raw text
      const bodyMatch = raw.match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (bodyMatch) {
        draftBody = bodyMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
        const subjMatch = raw.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (subjMatch) draftSubject = subjMatch[1].replace(/\\"/g, '"');
      } else {
        draftBody = raw;
      }
    }

    // B6 safety net: strip {firstName} / {name} placeholders that slipped through.
    draftSubject = substituteContactTokens(draftSubject, { name: recipient, firstName });
    draftBody = substituteContactTokens(draftBody, { name: recipient, firstName });

    res.json({ ok: true, subject: draftSubject, body: draftBody });
  } catch (err) {
    req.log.error({ err }, "Email draft suggestion failed");
    res.status(500).json({ error: "Failed to generate draft" });
  }
});

export default router;
