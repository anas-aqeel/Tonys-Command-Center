import { Router, type IRouter } from "express";
import { getGmail } from "../../lib/google-auth";
import { db, dailyBriefsTable } from "@workspace/db";
import { communicationLogTable, contactsTable } from "../../lib/schema-v2";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { updateContactComms } from "../../lib/contact-comms";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";

const router: IRouter = Router();

// Shared triage system prompt — used by /emails/reclassify-new + /emails/reclassify
// when AGENT_RUNTIME_EMAIL is OFF (legacy path). When ON, the runtime loads
// the equivalent body from agent_memory_entries (skill='triage').
const TRIAGE_SYSTEM_PROMPT = `You are Tony Diaz's email triage assistant for FlipIQ (real estate wholesaling).
Classify each email into exactly 3 categories: "important", "fyi", or "promotions".
Important: from @flipiq.com team, known contacts, or keywords: urgent, contract, payment, demo, equity, funding, deal.
FYI: medical, receipts, real-person notifications, updates relevant but need no reply.
Promotions: newsletters, marketing emails, automated notifications, social media.
Return ONLY valid JSON: { "important": [...], "fyi": [...], "promotions": [...] }
Important shape: { "from": string, "subj": string, "why": string, "time": string, "p": "high"|"med"|"low" }
FYI shape: { "from": string, "subj": string, "why": string }
Promotions shape: { "from": string, "subj": string, "why": string }`;

// Calls Claude (or runAgent when flag is on) and returns the classification JSON object.
// Both branches use the same model/max_tokens for byte-equivalence.
// v2 email/triage skill prompt emits {sender, subject, one_line_summary, ...}; legacy
// callers expect {from, subj, why, time?, p?}. We normalize at this single chokepoint
// so downstream code (attachId, FE) keeps the legacy contract.
function normalizeTriageItem(e: any): any {
  return {
    ...e,
    from: e.from ?? e.sender ?? "",
    subj: e.subj ?? e.subject ?? "",
    why: e.why ?? e.one_line_summary ?? e.suggested_action ?? "",
  };
}
async function classifyEmailsViaAi(userPrompt: string, opType: "poll" | "reclassify"): Promise<{ important?: any[]; fyi?: any[]; promotions?: any[] } | null> {
  let raw = "";
  if (isAgentRuntimeEnabled("email")) {
    // Append explicit shape so the v2 skill's default ThreadSummary schema doesn't override the caller's contract.
    const shapeHint = `\n\nReturn ONLY JSON: { "important":[...], "fyi":[...], "promotions":[...] }\nEach item: { "from": string, "subj": string, "why": string, "time": string, "p": "high"|"med"|"low" } (time and p only for important).`;
    const result = await runAgent("email", "triage", {
      userMessage: userPrompt + shapeHint,
      caller: "direct",
      meta: { opType },
      // 30-email batches blow past the skill's default budget; cap output at 4k
      // so truncated JSON doesn't crash the parse below.
      maxTokensOverride: 4096,
    });
    raw = result.text;
  } else {
    const claudeResponse = await createTrackedMessage(opType === "poll" ? "email_poll" : "email_poll_reclassify", {
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      system: TRIAGE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    const textBlock = claudeResponse.content.find(b => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;
    raw = textBlock.text;
  }
  // Strip markdown fence if present (v2 skills sometimes wrap output in ```json).
  let stripped = raw.trim().replace(/^```(?:json)?\s*\n?/i, "");
  const fenceEnd = stripped.indexOf("```");
  if (fenceEnd >= 0) stripped = stripped.slice(0, fenceEnd);
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("[classifyEmailsViaAi] no JSON in response. First 400 chars:", raw.slice(0, 400));
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn("[classifyEmailsViaAi] JSON.parse failed:", e instanceof Error ? e.message : e, "· raw len:", raw.length);
    return null;
  }
  return {
    important: (parsed.important || []).map(normalizeTriageItem),
    fyi: (parsed.fyi || []).map(normalizeTriageItem),
    promotions: (parsed.promotions || []).map(normalizeTriageItem),
  };
}

router.get("/emails/poll", async (req, res): Promise<void> => {
  try {
    const gmail = await getGmail();

    const fiveMinAgo = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);
    const list = await gmail.users.messages.list({
      userId: "me",
      maxResults: 20,
      q: `is:unread after:${fiveMinAgo}`,
    });

    const messages = list.data.messages || [];
    const newEmails: { from: string; subject: string; snippet: string; messageId: string; threadId: string }[] = [];

    for (const msg of messages) {
      const [existing] = await db.select({ id: communicationLogTable.id })
        .from(communicationLogTable)
        .where(eq(communicationLogTable.gmailMessageId, msg.id!))
        .limit(1);

      if (existing) continue;

      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers || [];
      const getHeader = (name: string) => headers.find(h => h.name === name)?.value || "";
      const from = getHeader("From");
      const subject = getHeader("Subject");
      const snippet = detail.data.snippet || "";

      const senderEmail = from.match(/<(.+?)>/)?.[1] || from;
      let matchedContactId: string | undefined;
      let matchedContactName: string | undefined;

      try {
        const [contact] = await db.select()
          .from(contactsTable)
          .where(sql`LOWER(${contactsTable.email}) = LOWER(${senderEmail})`)
          .limit(1);
        if (contact) {
          matchedContactId = contact.id;
          matchedContactName = contact.name;
        }
      } catch { /* no match */ }

      await db.insert(communicationLogTable).values({
        contactId: matchedContactId,
        contactName: matchedContactName || from,
        channel: "email_received",
        direction: "inbound",
        subject,
        summary: snippet.substring(0, 300),
        gmailMessageId: msg.id!,
        gmailThreadId: msg.threadId || undefined,
      });

      if (matchedContactId) {
        updateContactComms(matchedContactId, "email_received", subject).catch(() => {});
      }

      newEmails.push({
        from,
        subject,
        snippet,
        messageId: msg.id!,
        threadId: msg.threadId || "",
      });
    }

    res.json({ ok: true, newCount: newEmails.length, newEmails });
  } catch (err) {
    console.warn("[EmailPoll] failed:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Email poll failed" });
  }
});

// ─── GET /emails/unread — fetch all unread emails from last 24h ───────────────
router.get("/emails/unread", async (_req, res): Promise<void> => {
  try {
    const gmail = await getGmail();
    const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const list = await gmail.users.messages.list({
      userId: "me",
      maxResults: 50,
      q: `is:unread after:${oneDayAgo} in:inbox`,
    });

    const messages = list.data.messages || [];
    const emails: { from: string; subject: string; snippet: string; messageId: string; threadId: string; date: string }[] = [];

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });
      const headers = detail.data.payload?.headers || [];
      const getHeader = (name: string) => headers.find(h => h.name === name)?.value || "";
      emails.push({
        from: getHeader("From"),
        subject: getHeader("Subject"),
        snippet: detail.data.snippet || "",
        messageId: msg.id!,
        threadId: msg.threadId || "",
        date: getHeader("Date"),
      });
    }

    res.json({ ok: true, count: emails.length, emails });
  } catch (err) {
    console.warn("[EmailUnread] failed:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to fetch unread emails" });
  }
});

// ─── Reclassify only new emails and merge into cached brief ───────────────────
router.post("/emails/reclassify-new", async (req, res): Promise<void> => {
  try {
    const { newEmails } = req.body as { newEmails: { from: string; subject: string; snippet: string; messageId: string }[] };
    if (!newEmails?.length) { res.json({ ok: true, added: 0 }); return; }

    // Classify new emails via the shared helper (legacy or runAgent based on flag)
    const userPrompt = `Classify these ${newEmails.length} new emails:\n${JSON.stringify(newEmails.map(e => ({ from: e.from, subject: e.subject, snippet: e.snippet })), null, 2)}`;
    const classified = await classifyEmailsViaAi(userPrompt, "poll");
    if (!classified) { res.json({ ok: false, error: "No classification" }); return; }

    // Merge into existing cached brief
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const [dbBrief] = await db.select().from(dailyBriefsTable).where(eq(dailyBriefsTable.date, today));

    const existingImportant = (dbBrief?.emailsImportant as any[]) ?? [];
    const existingFyi = (dbBrief?.emailsFyi as any[]) ?? [];

    // Add gmailMessageId to new classified emails by matching from+subject
    const msgIdMap = new Map(newEmails.map(e => [
      e.from.replace(/<[^>]+>/, "").trim().toLowerCase().slice(0, 30) + "|" + e.subject.toLowerCase().slice(0, 40),
      e.messageId,
    ]));
    const attachId = (e: any) => {
      const key = (e.from || "").toLowerCase().slice(0, 30) + "|" + (e.subj || "").toLowerCase().slice(0, 40);
      return { ...e, gmailMessageId: msgIdMap.get(key) || undefined };
    };

    const newImportant = (classified.important || []).map((e: any, i: number) => attachId({ ...e, id: 100 + i }));
    const newFyi = (classified.fyi || []).map((e: any, i: number) => ({ ...e, id: 110 + i }));
    const newPromotions = (classified.promotions || []).map((e: any, i: number) => ({ ...e, id: 120 + i }));

    const mergedImportant = [...newImportant, ...existingImportant];
    const mergedFyi = [...newFyi, ...existingFyi];

    if (dbBrief) {
      await db.update(dailyBriefsTable).set({ emailsImportant: mergedImportant, emailsFyi: mergedFyi }).where(eq(dailyBriefsTable.date, today));
    }

    res.json({
      ok: true,
      added: newImportant.length + newFyi.length + newPromotions.length,
      emailsImportant: mergedImportant,
      emailsFyi: mergedFyi,
      emailsPromotions: newPromotions,
    });
  } catch (err) {
    console.warn("[EmailReclassify] failed:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Reclassify failed" });
  }
});

// ─── Universal reclassify with mode parameter ──────────────────────────────────
// modes:
//   "new"       — classify just the provided pendingNewEmails array (append to brief)
//   "unread"    — fetch all unread emails from inbox, classify all (replace brief lists)
//   "last_24h"  — fetch ALL emails (read + unread) from last 24h, classify all (replace brief lists)
//   "custom"    — fetch ALL emails since the provided 'sinceUnixSeconds' timestamp (replace brief lists)
router.post("/emails/reclassify", async (req, res): Promise<void> => {
  try {
    const { mode, sinceUnixSeconds, newEmails } = req.body as {
      mode: "new" | "unread" | "last_24h" | "custom";
      sinceUnixSeconds?: number;
      newEmails?: { from: string; subject: string; snippet: string; messageId: string }[];
    };

    if (!mode) { res.status(400).json({ error: "mode required" }); return; }

    // ── Build the email list to classify (depending on mode) ────────────────
    let toClassify: { from: string; subject: string; snippet: string; messageId: string; date?: string }[] = [];

    if (mode === "new") {
      if (!newEmails?.length) { res.json({ ok: true, added: 0, mode }); return; }
      toClassify = newEmails;
    } else {
      const gmail = await getGmail();
      let q = "in:inbox";
      if (mode === "unread") q += " is:unread";
      else if (mode === "last_24h") {
        const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
        q += ` after:${since}`;
      } else if (mode === "custom") {
        if (!sinceUnixSeconds) { res.status(400).json({ error: "sinceUnixSeconds required for custom mode" }); return; }
        q += ` after:${sinceUnixSeconds}`;
      }

      const list = await gmail.users.messages.list({ userId: "me", maxResults: 50, q });
      const messages = list.data.messages || [];

      const details = await Promise.all(
        messages.slice(0, 30).map(msg =>
          gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          })
        )
      );

      toClassify = details.map((d, i) => {
        const hdrs = d.data.payload?.headers || [];
        const get = (name: string) => hdrs.find(h => h.name === name)?.value || "";
        return {
          from: get("From"),
          subject: get("Subject"),
          snippet: d.data.snippet || "",
          messageId: messages[i]?.id || "",
          date: get("Date"),
        };
      });
    }

    if (toClassify.length === 0) { res.json({ ok: true, added: 0, mode, emailsImportant: [], emailsFyi: [], emailsPromotions: [] }); return; }

    // ── Run classification via shared helper (legacy or runAgent based on flag) ──
    const userPrompt = `Classify these ${toClassify.length} emails:\n${JSON.stringify(toClassify.map(e => ({ from: e.from, subject: e.subject, snippet: e.snippet })), null, 2)}`;
    const classified = await classifyEmailsViaAi(userPrompt, "reclassify");
    if (!classified) { res.json({ ok: false, error: "No classification" }); return; }

    // ── Attach gmailMessageId by from+subject lookup ─────────────────────────
    const msgIdMap = new Map(toClassify.map(e => [
      e.from.replace(/<[^>]+>/, "").trim().toLowerCase().slice(0, 30) + "|" + e.subject.toLowerCase().slice(0, 40),
      e.messageId,
    ]));
    const attachId = (e: any) => {
      const key = (e.from || "").toLowerCase().slice(0, 30) + "|" + (e.subj || "").toLowerCase().slice(0, 40);
      return { ...e, gmailMessageId: msgIdMap.get(key) || undefined };
    };

    const newImportant = (classified.important || []).map((e: any, i: number) => attachId({ ...e, id: i + 1 }));
    const newFyi = (classified.fyi || []).map((e: any, i: number) => ({ ...e, id: i + 100 }));
    const newPromotions = (classified.promotions || []).map((e: any, i: number) => ({ ...e, id: i + 200 }));

    // ── Merge or replace in daily brief ──────────────────────────────────────
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const [dbBrief] = await db.select().from(dailyBriefsTable).where(eq(dailyBriefsTable.date, today));

    let resultImportant = newImportant;
    let resultFyi = newFyi;
    let resultPromotions = newPromotions;

    if (mode === "new") {
      // Append to existing
      const existingImportant = (dbBrief?.emailsImportant as any[]) ?? [];
      const existingFyi = (dbBrief?.emailsFyi as any[]) ?? [];
      resultImportant = [...newImportant, ...existingImportant];
      resultFyi = [...newFyi, ...existingFyi];
      // promotions stay as just new (existing scheme)
    }
    // For unread/last_24h/custom: replace lists outright

    if (dbBrief) {
      await db.update(dailyBriefsTable)
        .set({ emailsImportant: resultImportant, emailsFyi: resultFyi })
        .where(eq(dailyBriefsTable.date, today));
    }

    res.json({
      ok: true,
      mode,
      classified: toClassify.length,
      emailsImportant: resultImportant,
      emailsFyi: resultFyi,
      emailsPromotions: resultPromotions,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.warn("[EmailReclassify] failed:", msg, stack);
    res.status(500).json({ error: "Reclassify failed", detail: msg.slice(0, 500), stack: stack?.split("\n").slice(0, 6).join(" | ") });
  }
});

export default router;
