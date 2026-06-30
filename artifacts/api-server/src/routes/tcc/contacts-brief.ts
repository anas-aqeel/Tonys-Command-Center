import { Router, type IRouter } from "express";
import { z } from "zod";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";
import { substituteContactTokens } from "../../lib/contact-tokens.js";
import { sharedDb, contactsTable, meetingHistoryTable } from "@workspace/db";
import { contactIntelligenceTable, communicationLogTable, contactBriefsTable } from "../../lib/schema-v2";
import { eq, desc, ilike } from "drizzle-orm";

const router: IRouter = Router();

const BriefBody = z.object({
  contactId: z.string().uuid(),
});

router.post("/contacts/brief", async (req, res): Promise<void> => {
  const parsed = BriefBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { contactId } = parsed.data;

  try {
    const [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const [intel] = await sharedDb.select().from(contactIntelligenceTable)
      .where(eq(contactIntelligenceTable.contactId, contactId)).limit(1);

    const recentComms = await sharedDb.select().from(communicationLogTable)
      .where(eq(communicationLogTable.contactId, contactId))
      .orderBy(desc(communicationLogTable.loggedAt))
      .limit(10);

    // meeting_history is keyed by contact_name (text), not contact_id —
    // ILIKE match on the contact's canonical name. See lib/db/src/schema/tcc.ts.
    const recentMeetings = contact.name
      ? await sharedDb.select().from(meetingHistoryTable)
          .where(ilike(meetingHistoryTable.contactName, `%${contact.name.trim()}%`))
          .orderBy(desc(meetingHistoryTable.date))
          .limit(5)
      : [];

    // Compute last interaction across both comms log and meetings so the
    // brief shows "Last meeting: 2026-05-06 — <topic>" instead of
    // "No communication log entries" when meetings exist but no comms do.
    const lastCommAt = recentComms[0]?.loggedAt ? new Date(recentComms[0].loggedAt) : null;
    const lastMeetingAt = recentMeetings[0]?.date ? new Date(recentMeetings[0].date) : null;
    let lastInteractionAt: Date | null = null;
    let lastInteractionVia: string | null = null;
    if (lastCommAt && lastMeetingAt) {
      if (lastCommAt >= lastMeetingAt) {
        lastInteractionAt = lastCommAt;
        lastInteractionVia = recentComms[0].channel;
      } else {
        lastInteractionAt = lastMeetingAt;
        lastInteractionVia = "meeting";
      }
    } else if (lastCommAt) {
      lastInteractionAt = lastCommAt;
      lastInteractionVia = recentComms[0].channel;
    } else if (lastMeetingAt) {
      lastInteractionAt = lastMeetingAt;
      lastInteractionVia = "meeting";
    }

    let openTasks: string[] = [];
    if (contact.nextStep) openTasks.push(contact.nextStep);
    if (intel?.nextAction) openTasks.push(intel.nextAction);

    let context = `Contact: ${contact.name}\nCompany: ${contact.company || "N/A"}\nType: ${contact.type || "N/A"}\nStatus (temperature): ${contact.status}\nPhone: ${contact.phone || "N/A"}\nEmail: ${contact.email || "N/A"}\nNext Step: ${contact.nextStep || "None"}`;

    if (lastInteractionAt) {
      context += `\nLast interaction: ${lastInteractionAt.toLocaleDateString()} (via ${lastInteractionVia})`;
    }

    if (intel) {
      context += `\n\nIntelligence:\nAI Score: ${intel.aiScore || "Not scored"}\nStage (pipeline): ${intel.stage}\nLinkedIn: ${intel.linkedinUrl || "N/A"}\nPersonality Notes: ${intel.personalityNotes || "N/A"}`;
      if (intel.companyInfo && typeof intel.companyInfo === "object") {
        const ci = intel.companyInfo as Record<string, string>;
        context += `\nCompany Info: ${ci.summary || "N/A"}`;
        if (ci.news) context += `\nRecent News: ${ci.news}`;
      }
    }

    if (openTasks.length > 0) {
      context += `\n\nOpen Tasks Related to This Person:\n${openTasks.map(t => `- ${t}`).join("\n")}`;
    }

    // Always emit explicit counts so the AI can distinguish "data was checked
    // and was empty" from "data wasn't loaded into the prompt". Without this,
    // the AI tended to claim "no communication log provided" when in fact
    // both sources had simply been empty for this contact.
    if (recentComms.length > 0) {
      context += `\n\nRecent Communications (last ${recentComms.length}):`;
      for (const c of recentComms) {
        context += `\n- [${c.channel}] ${c.loggedAt ? new Date(c.loggedAt).toLocaleDateString() : "?"}: ${c.summary || c.subject || "No summary"}`;
      }
    } else {
      context += `\n\nRecent Communications: 0 entries.`;
    }

    if (recentMeetings.length > 0) {
      context += `\n\nRecent Meetings (last ${recentMeetings.length}):`;
      for (const m of recentMeetings) {
        const parts: string[] = [];
        if (m.summary) parts.push(`Summary: ${m.summary}`);
        if (m.outcome) parts.push(`Outcome: ${m.outcome}`);
        if (m.nextSteps) parts.push(`Next steps: ${m.nextSteps}`);
        const body = parts.length > 0 ? parts.join(" | ") : "No notes";
        context += `\n- [${m.date}] ${body}`;
      }
    } else {
      context += `\n\nRecent Meetings: 0 entries.`;
    }

    const userPrompt = `You are Tony Diaz's sales assistant. Generate a pre-call brief for Tony. Be direct and actionable. Tony has ADHD so keep it scannable.

Include these sections:
1. QUICK SUMMARY (2-3 sentences: who they are, relationship status, what to talk about)
2. COMMUNICATION STYLE (one line: e.g., "Direct communicator. Don't pitch -- ask questions." or "Relationship-builder. Start with small talk.")
3. AI PERSONALITY ASSESSMENT (one line coaching tip based on their communication patterns)
4. KEY ACTION (one clear thing Tony should ask for or accomplish on this call)

${context}`;

    let briefText = "Unable to generate brief.";

    // Flag-gated: AGENT_RUNTIME_CONTACTS=true routes through runtime.
    // Runtime path sends only contact data; brief format/sections in skill body.
    if (isAgentRuntimeEnabled("contacts")) {
      const result = await runAgent("contacts", "pre-call-brief", {
        userMessage: context.trim() || `Contact: ${contact.name}`,
        caller: "direct",
        meta: { contactId },
      });
      briefText = result.text || briefText;
    } else {
      const response = await createTrackedMessage("contact_brief", {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 768,
        messages: [{ role: "user", content: userPrompt }],
      });
      const textBlock = response.content.find(b => b.type === "text");
      briefText = textBlock?.type === "text" ? textBlock.text : briefText;
    }

    // B6 safety net: replace any {firstName}/{name} placeholders the model
    // may have leaked into the brief (less likely than for emails, but the
    // brief mentions the contact by name throughout).
    briefText = substituteContactTokens(briefText, { name: contact.name });

    await sharedDb.insert(contactBriefsTable).values({
      contactId,
      contactName: contact.name,
      briefText,
      openTasks: openTasks.length > 0 ? openTasks : [],
      recentCommunications: recentComms.slice(0, 5).map(c => ({
        channel: c.channel,
        summary: c.summary || c.subject,
        date: c.loggedAt,
      })),
    });

    res.json({
      ok: true,
      contactId,
      contactName: contact.name,
      briefText,
      aiScore: intel?.aiScore || null,
      stage: intel?.stage || "new",
      status: contact.status || "New",
      linkedinUrl: intel?.linkedinUrl || null,
      personalityNotes: intel?.personalityNotes || null,
      openTasks,
      recentComms: recentComms.slice(0, 5).map(c => ({
        channel: c.channel,
        summary: c.summary || c.subject,
        date: c.loggedAt,
      })),
    });
  } catch (err) {
    console.error("[contacts-brief] Error:", err);
    res.status(500).json({ error: "Failed to generate brief" });
  }
});

router.get("/contacts/:contactId/brief", async (req, res): Promise<void> => {
  const [brief] = await sharedDb.select().from(contactBriefsTable)
    .where(eq(contactBriefsTable.contactId, req.params.contactId))
    .orderBy(desc(contactBriefsTable.generatedAt))
    .limit(1);

  if (!brief) { res.status(404).json({ error: "No brief found" }); return; }
  res.json(brief);
});

// ─── POST /contacts/brief/chat — continue the pre-call brief conversation ──
// When the brief flags a data conflict (e.g. record says investor but recent
// comms read like internal team work), Tony clicks "💬 Continue with Chat"
// and asks follow-up questions. This route resolves the contact context fresh
// each turn so the AI always reasons over the canonical CRM state, not a
// stale snapshot from when the brief was first generated.
const ChatBody = z.object({
  contactId: z.string().uuid(),
  briefText: z.string(),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).min(1).max(40),
});

router.post("/contacts/brief/chat", async (req, res): Promise<void> => {
  const parsed = ChatBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { contactId, briefText, messages } = parsed.data;

  try {
    // Re-fetch contact + comms so the AI sees current data, not a stale snapshot.
    const [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const [intel] = await sharedDb.select().from(contactIntelligenceTable)
      .where(eq(contactIntelligenceTable.contactId, contactId)).limit(1);

    const recentComms = await sharedDb.select().from(communicationLogTable)
      .where(eq(communicationLogTable.contactId, contactId))
      .orderBy(desc(communicationLogTable.loggedAt))
      .limit(10);

    // meeting_history rows match by contact name (no contact_id column).
    const recentMeetings = contact.name
      ? await sharedDb.select().from(meetingHistoryTable)
          .where(ilike(meetingHistoryTable.contactName, `%${contact.name.trim()}%`))
          .orderBy(desc(meetingHistoryTable.date))
          .limit(5)
      : [];

    const lastCommAt = recentComms[0]?.loggedAt ? new Date(recentComms[0].loggedAt) : null;
    const lastMeetingAt = recentMeetings[0]?.date ? new Date(recentMeetings[0].date) : null;
    let lastInteractionAt: Date | null = null;
    let lastInteractionVia: string | null = null;
    if (lastCommAt && lastMeetingAt) {
      if (lastCommAt >= lastMeetingAt) {
        lastInteractionAt = lastCommAt;
        lastInteractionVia = recentComms[0].channel;
      } else {
        lastInteractionAt = lastMeetingAt;
        lastInteractionVia = "meeting";
      }
    } else if (lastCommAt) {
      lastInteractionAt = lastCommAt;
      lastInteractionVia = recentComms[0].channel;
    } else if (lastMeetingAt) {
      lastInteractionAt = lastMeetingAt;
      lastInteractionVia = "meeting";
    }

    let contextBlock = `Contact record:\n- Name: ${contact.name}\n- Company: ${contact.company || "—"}\n- Type: ${contact.type || "—"}\n- Status: ${contact.status}\n- Stage: ${intel?.stage || "—"}\n- AI Score: ${intel?.aiScore || "—"}\n- LinkedIn: ${intel?.linkedinUrl || "—"}\n- Email: ${contact.email || "—"}\n- Phone: ${contact.phone || "—"}\n- Next step: ${contact.nextStep || "—"}`;
    if (intel?.personalityNotes) contextBlock += `\n- Personality notes: ${intel.personalityNotes}`;
    if (lastInteractionAt) {
      contextBlock += `\n- Last interaction: ${lastInteractionAt.toLocaleDateString()} (via ${lastInteractionVia})`;
    }

    // Always emit explicit counts on both sources so the AI can't claim "data
    // not provided" when it was checked-and-empty. The brief chat used to say
    // "I don't see any communication log here" even when meetings existed.
    if (recentComms.length > 0) {
      contextBlock += `\n\nRecent communications (last ${recentComms.length}):`;
      for (const c of recentComms) {
        const date = c.loggedAt ? new Date(c.loggedAt).toLocaleDateString() : "?";
        contextBlock += `\n- [${c.channel}] ${date}: ${c.summary || c.subject || "—"}`;
      }
    } else {
      contextBlock += `\n\nRecent communications: 0 entries.`;
    }

    if (recentMeetings.length > 0) {
      contextBlock += `\n\nRecent meetings (last ${recentMeetings.length}):`;
      for (const m of recentMeetings) {
        const parts: string[] = [];
        if (m.summary) parts.push(`Summary: ${m.summary}`);
        if (m.outcome) parts.push(`Outcome: ${m.outcome}`);
        if (m.nextSteps) parts.push(`Next steps: ${m.nextSteps}`);
        const body = parts.length > 0 ? parts.join(" | ") : "No notes";
        contextBlock += `\n- [${m.date}] ${body}`;
      }
    } else {
      contextBlock += `\n\nRecent meetings: 0 entries.`;
    }

    contextBlock += `\n\n---\n\nPRE-CALL BRIEF ALREADY SHOWN TO TONY:\n${briefText}`;

    // Inject the context block into the FIRST user message so the skill body
    // (which is loaded as L3) receives the canonical contact state alongside
    // Tony's question. Subsequent turns are passed verbatim.
    const firstUser = messages[0];
    const firstUserAugmented = firstUser.role === "user"
      ? { role: "user" as const, content: `${contextBlock}\n\n---\n\nTony asks:\n${firstUser.content}` }
      : firstUser;
    const augmentedMessages = [firstUserAugmented, ...messages.slice(1)];

    let replyText = "";

    if (isAgentRuntimeEnabled("contacts")) {
      // The runtime expects a single user message — collapse the chat thread
      // into one message-block array that the runtime's prompt builder will
      // hand to Anthropic alongside the skill body system prompt.
      const result = await runAgent("contacts", "brief-chat", {
        userMessage: augmentedMessages.map(m => `${m.role === "user" ? "Tony" : "Assistant"}: ${m.content}`).join("\n\n"),
        caller: "direct",
        meta: { contactId, turn: messages.length },
      });
      replyText = result.text || "";
    } else {
      const legacySystem = `You are Tony Diaz's sales assistant continuing a pre-call brief conversation. Tony just read the brief and has follow-up questions. Voice: direct, operator-to-operator, no salesy language. Default 2-4 sentences per turn. Don't re-summarize the brief — answer the new question. When the contact-type field conflicts with the comms log, trust the comms log and surface the discrepancy. Always commit to a recommendation; never refuse the question.`;
      const response = await createTrackedMessage("contact_brief_chat", {
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: legacySystem,
        messages: augmentedMessages,
      });
      const block = response.content.find(b => b.type === "text");
      replyText = block?.type === "text" ? block.text : "";
    }

    res.json({ ok: true, reply: replyText.trim() });
  } catch (err) {
    console.error("[contacts/brief/chat] error:", err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
