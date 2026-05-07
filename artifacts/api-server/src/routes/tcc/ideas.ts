import { Router, type IRouter } from "express";
import { db, ideasTable } from "@workspace/db";
import { ParkIdeaBody } from "@workspace/api-zod";
import { desc, eq } from "drizzle-orm";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { createLinearIssue, getLinearMembers } from "../../lib/linear";
import { postTechIdeaToSlack, postSlackMessage, listSlackUsers, notifyAssigneeViaSlack } from "../../lib/slack";
import { z } from "zod/v4";
import { businessContextTable, teamRolesTable } from "../../lib/schema-v2";
import { recordFeedback } from "../../agents/feedback.js";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";

const router: IRouter = Router();

async function getBusinessContext(): Promise<string> {
  const rows = await db.select().from(businessContextTable).limit(5);
  if (!rows.length) return "";
  return rows.map(r => `[${r.documentType}] ${r.summary || r.content?.substring(0, 300) || ""}`.trim()).join("\n");
}

// ─── Team members: merge team_roles (canonical) + Linear + Slack ─────────────
// `team_roles` is the canonical source of FlipIQ team members with verified Slack
// IDs (seeded via /business/team/seed). Linear and Slack workspace scans
// supplement with members not already in team_roles. Slack ID match prefers:
//   1. team_roles.slack_id (canonical)
//   2. slackByEmail (workspace scan email match)
//   3. slackByName (workspace scan display-name match)
router.get("/ideas/team-members", async (_req, res): Promise<void> => {
  try {
    const [teamRoles, linearMembers, slackResult] = await Promise.allSettled([
      db.select().from(teamRolesTable).orderBy(teamRolesTable.position),
      getLinearMembers(),
      listSlackUsers(),
    ]);

    const team = teamRoles.status === "fulfilled" ? teamRoles.value : [];
    const linear = linearMembers.status === "fulfilled" ? linearMembers.value : [];
    const slackUsers = slackResult.status === "fulfilled" ? (slackResult.value.members ?? []) : [];

    // Workspace-scan lookup maps for Slack ID matching
    const slackByEmail = new Map<string, string>();
    const slackByName = new Map<string, string>();
    for (const su of slackUsers) {
      const email = su.profile?.email?.toLowerCase();
      if (email) slackByEmail.set(email, su.id);
      const displayName = (su.profile?.display_name || su.real_name || "").toLowerCase();
      if (displayName) slackByName.set(displayName, su.id);
    }

    // Layer 1: team_roles — canonical roster with hard-coded Slack IDs
    const members: { name: string; email: string | null; slackId: string | null; source: string }[] = team
      .filter(t => t.name && (t.email || t.slackId)) // need at least one channel
      .map(t => ({
        name: t.name,
        email: t.email || null,
        slackId: t.slackId
          || (t.email ? slackByEmail.get(t.email.toLowerCase()) : null)
          || slackByName.get(t.name.toLowerCase())
          || null,
        source: "team_roles",
      }));

    const coveredEmails = new Set(members.map(m => m.email?.toLowerCase()).filter(Boolean) as string[]);
    const coveredNames = new Set(members.map(m => m.name.toLowerCase()));

    // Layer 2: Linear members not already in team_roles
    for (const lm of linear) {
      const emailKey = lm.email.toLowerCase();
      const nameKey = (lm.displayName || lm.name).toLowerCase();
      if (coveredEmails.has(emailKey) || coveredNames.has(nameKey)) continue;
      members.push({
        name: lm.displayName || lm.name,
        email: lm.email,
        slackId: slackByEmail.get(emailKey) || slackByName.get(nameKey) || null,
        source: "linear",
      });
      coveredEmails.add(emailKey);
      coveredNames.add(nameKey);
    }

    // Layer 3: Slack-only users not already covered
    for (const su of slackUsers) {
      const email = su.profile?.email;
      if (!email || coveredEmails.has(email.toLowerCase())) continue;
      members.push({
        name: su.profile?.display_name || su.real_name || su.name,
        email,
        slackId: su.id,
        source: "slack",
      });
      coveredEmails.add(email.toLowerCase());
    }

    // Filter out bots, noreply, Linear/integration accounts, and obvious
    // non-humans. Allow null email when member has a slackId.
    const filtered = members.filter(m => {
      if (!m.name) return false;
      if (m.email) {
        const e = m.email.toLowerCase();
        if (e.includes("noreply") || e.includes("bot@")) return false;
        if (e.includes("@linear.linear.app") || e.startsWith("linear-")) return false;
      } else if (!m.slackId) {
        return false; // no email AND no slack → can't notify
      }
      return true;
    });
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ ok: true, members: filtered });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err), members: [] });
  }
});

const BUSINESS_PLAN = `FlipIQ is a real estate wholesale platform.
- NORTH STAR: Every Acquisition Associate closes 2 deals/month
- Revenue: $50K break-even → $100K Phase 1 → $250K scale
- Core: Sales calls, demos, follow-ups FIRST
- Tech: Only build what moves needles — no distractions
- Partners: Strategic relationships that bring deals or capital
- Marketing: Content that drives inbound leads at scale`;

async function classifyIdea(text: string, recentIdeas: typeof ideasTable.$inferSelect[]): Promise<{
  category: string;
  urgency: string;
  techType: string | null;
  reason: string;
  businessFit: string;
  priority: string;
  warningIfDistraction?: string;
}> {
  const recentList = recentIdeas.slice(0, 5).map((i, idx) =>
    `#${idx + 1}: [${i.category}] ${i.text}`
  ).join("\n") || "None yet.";

  const liveContext = await getBusinessContext().catch(() => "");

  const userPrompt = `You are Tony Diaz's AI classifier for FlipIQ ideas. Analyze this idea and return ONLY valid JSON.

BUSINESS CONTEXT:
${liveContext ? `LIVE BUSINESS DOCUMENTS (primary source):\n${liveContext}` : BUSINESS_PLAN}

RECENT IDEAS (for context):
${recentList}

NEW IDEA: "${text}"

Return EXACTLY this JSON:
{
  "category": "Tech|Sales|Marketing|Strategic Partners|Operations|Product|Personal",
  "urgency": "Now|This Week|This Month|Someday",
  "techType": "Bug|Feature|Note|Task|Strategic|null",
  "reason": "One sentence explaining why this category fits",
  "businessFit": "One sentence on how this moves the FlipIQ needle",
  "priority": "high|medium|low",
  "warningIfDistraction": "Optional: one sentence warning if this might distract Tony from sales"
}

IMPORTANT: Use techType "Task" when the idea is a concrete action item that should be checked against the 90-day plan. Use "Strategic" when the idea is a high-level strategic direction that Ethan should review. Use "Bug", "Feature", or "Idea" only for tech-related submissions.

Return ONLY the JSON object, no markdown, no explanation.`;

  let raw = "";

  // Flag-gated: AGENT_RUNTIME_IDEAS=true routes through runtime.
  // Runtime path: send only dynamic data; classification rules in skill body.
  if (isAgentRuntimeEnabled("ideas")) {
    const runtimeMessage = `BUSINESS CONTEXT:
${liveContext ? `LIVE BUSINESS DOCUMENTS:\n${liveContext}` : BUSINESS_PLAN}

RECENT IDEAS (for context):
${recentList}

NEW IDEA: "${text}"`;

    const result = await runAgent("ideas", "classify", {
      userMessage: runtimeMessage,
      caller: "direct",
      meta: { ideaText: text.slice(0, 80) },
    });
    raw = result.text.trim();
  } else {
    const msg = await createTrackedMessage("idea_classify", {
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: userPrompt }],
    });
    const block = msg.content[0];
    if (block.type !== "text") throw new Error("Bad AI response");
    raw = block.text.trim();
  }

  // Robust JSON extraction: strip optional markdown fence, fall back to first
  // {...} block. Models sometimes append prose after the JSON, so we can't rely
  // on `.replace(/```$/, "")` matching at end-of-string.
  let json = raw.replace(/^\s*```(?:json)?\s*\n?/i, "");
  const fenceEnd = json.indexOf("```");
  if (fenceEnd >= 0) json = json.slice(0, fenceEnd);
  json = json.trim();
  if (!json.startsWith("{")) {
    const m = json.match(/\{[\s\S]*\}/);
    if (m) json = m[0];
  }
  const parsed = JSON.parse(json);

  // Some models wrap output as { classification: {...}, reason: "..." } despite
  // the schema. Unwrap if we see that shape.
  if (parsed && typeof parsed === "object" && parsed.classification && typeof parsed.classification === "object" && !parsed.category) {
    return { ...parsed.classification, ...parsed, classification: undefined };
  }
  return parsed;
}

// ─── Claude-powered Slack notification for Tech ideas ─────────────────────────
async function notifyTechIdeaViaClaude(idea: {
  text: string;
  urgency: string;
  techType: string | null;
  linearIdentifier?: string;
}): Promise<void> {
  const result = await postTechIdeaToSlack(idea);

  if (!result.ok) {
    console.info("[Ideas] Slack notification skipped (not connected):", idea.text.slice(0, 60));
  } else {
    console.info("[Ideas] Posted tech idea to #tech-ideas Slack channel");
  }
}

const ClassifyIdeaBody = z.object({
  text: z.string().min(1, "text is required"),
});

router.get("/ideas", async (req, res): Promise<void> => {
  const ideas = await db.select().from(ideasTable).orderBy(desc(ideasTable.createdAt));
  res.json(ideas);
});

// Pre-classify an idea before saving (so user can review and override)
router.post("/ideas/classify", async (req, res): Promise<void> => {
  const parsed = ClassifyIdeaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { text } = parsed.data;
  const recentIdeas = await db.select().from(ideasTable).orderBy(desc(ideasTable.createdAt)).limit(5);

  const VALID_CATS = ["Tech", "Sales", "Marketing", "Strategic Partners", "Operations", "Product", "Personal"] as const;
  const VALID_URG = ["Now", "This Week", "This Month", "Someday"] as const;
  const VALID_TT = ["Bug", "Feature", "Note", "Task", "Strategic"] as const;

  let classification: Awaited<ReturnType<typeof classifyIdea>>;
  try {
    classification = await classifyIdea(text, recentIdeas);
  } catch (err) {
    req.log.warn({ err }, "Idea classification failed");
    res.json({
      ok: true,
      classification: {
        category: "Operations",
        urgency: "This Week",
        techType: null,
        reason: "Could not auto-classify — defaulting to Operations.",
        businessFit: "Review manually.",
        priority: "medium",
        pushback: null,
      }
    });
    return;
  }

  // Normalize: AI sometimes returns invalid enum values (e.g. category="Strategic"
  // or urgency="Parked"). Coerce to valid options so the FE doesn't get "Tech" by
  // default fallback and lose the AI's actual signal.
  if (!VALID_CATS.includes(classification.category as any)) {
    if (classification.category === "Strategic") {
      classification.category = "Strategic Partners";
      if (!classification.techType) classification.techType = "Strategic";
    } else {
      classification.category = "Operations";
    }
  }
  if (!VALID_URG.includes(classification.urgency as any)) {
    classification.urgency = "This Week";
  }
  if (classification.techType && !VALID_TT.includes(classification.techType as any)) {
    classification.techType = null;
  }
  if (!classification.reason) classification.reason = "Auto-classified.";
  if (!classification.businessFit) classification.businessFit = "Review manually.";
  if (!["high", "medium", "low"].includes(classification.priority)) {
    classification.priority = "medium";
  }

  // ── Pushback: check against all business context documents ──
  let pushback: { message: string; priorityRank: number | null; action: "park" | "override" | "escalate" | null } | null = null;

  try {
    const contextDocs = await db.select().from(businessContextTable);
    const northStar = contextDocs.find(d => d.documentType === "north_star")?.content || "";
    const businessPlan = contextDocs.find(d => d.documentType === "business_plan")?.content || "";
    const ninetyDayPlan = contextDocs.find(d => d.documentType === "90_day_plan")?.content || "";

    const combinedContext = [
      northStar ? `NORTH STAR:\n${northStar.substring(0, 1000)}` : "",
      businessPlan ? `BUSINESS PLAN:\n${businessPlan.substring(0, 2000)}` : "",
      ninetyDayPlan ? `90-DAY PLAN:\n${ninetyDayPlan.substring(0, 2000)}` : "",
    ].filter(Boolean).join("\n\n");

    if (combinedContext) {
      const isTechBug = classification.category === "Tech" && classification.techType === "Bug";

      if (isTechBug) {
        pushback = {
          message: "Tech bug detected. Auto-posting to #engineering with severity + priority recommendation.",
          priorityRank: null,
          action: null,
        };
        postSlackMessage({
          channel: "C0A3CS15MPT",
          text: `*Bug Report (auto-filed from TCC)*\n\n> ${text}\n\n*Severity:* ${classification.urgency || "Unknown"}\n*Priority Recommendation:* ${classification.urgency === "Now" ? "P1" : classification.urgency === "This Week" ? "P2" : "P3"}`,
        }).catch(() => {});
      } else {
        const pushbackPrompt = `Given these business priorities:\n${combinedContext}\n\nA new idea was submitted: "${text}"\n\nDoes this conflict with or distract from current priorities? If yes, estimate what priority rank (1-100) this would be on the 90-day plan. Is this unreasonable enough to park and escalate to Ethan?\n\nRespond as JSON only: { "conflicts": true/false, "rank": number|null, "reason": "brief explanation", "unreasonable": true/false }`;

        let pushbackRaw = "";

        // Flag-gated: AGENT_RUNTIME_IDEAS=true routes through runtime.
        // Runtime path sends only data; pushback heuristics are in the skill body.
        if (isAgentRuntimeEnabled("ideas")) {
          const runtimeMessage = `Business priorities:\n${combinedContext}\n\nNew idea: "${text}"`;
          const result = await runAgent("ideas", "pushback", {
            userMessage: runtimeMessage,
            caller: "direct",
            meta: { ideaText: text.slice(0, 80) },
          });
          pushbackRaw = result.text;
        } else {
          const pushbackCheck = await createTrackedMessage("idea_classify", {
            model: "claude-haiku-4-5",
            max_tokens: 512,
            messages: [{ role: "user", content: pushbackPrompt }],
          });
          const pushbackText = pushbackCheck.content.find(b => b.type === "text");
          if (pushbackText?.type === "text") pushbackRaw = pushbackText.text;
        }

        if (pushbackRaw) {
          try {
            // Robust extract: strip fence, isolate first {...} block, then parse.
            let cleaned = pushbackRaw.trim().replace(/^\s*```(?:json)?\s*\n?/i, "");
            const fenceEnd = cleaned.indexOf("```");
            if (fenceEnd >= 0) cleaned = cleaned.slice(0, fenceEnd);
            cleaned = cleaned.trim();
            if (!cleaned.startsWith("{")) {
              const m = cleaned.match(/\{[\s\S]*\}/);
              if (m) cleaned = m[0];
            }
            const parsed2 = JSON.parse(cleaned);
            if (parsed2.unreasonable) {
              pushback = {
                message: "I'm parking this and booking a meeting with Ethan to discuss.",
                priorityRank: parsed2.rank ?? null,
                action: "escalate",
              };
            } else if (parsed2.conflicts && parsed2.rank && parsed2.rank > 10) {
              pushback = {
                message: `This is #${parsed2.rank} on your 90-day plan. Convince me why it should jump to #1.`,
                priorityRank: parsed2.rank,
                action: "park",
              };
            }
          } catch { /* ignore parse errors */ }
        }
      }
    }
  } catch { /* non-critical — pushback stays null */ }

  // ── Special handling: Task type → check 90-day plan ──
  let additionalContext: string | null = null;
  if (classification.techType === "Task") {
    try {
      const ninetyDayDoc = await db.select().from(businessContextTable).limit(10);
      const plan = ninetyDayDoc.find(d => d.documentType === "90_day_plan");
      if (plan?.content) {
        additionalContext = `This idea was classified as a "Task". It has been checked against your 90-day plan:\n${plan.content.substring(0, 1500)}`;
      }
    } catch { /* non-critical */ }
  }

  // ── Special handling: Strategic type → flag for Ethan review ──
  if (classification.techType === "Strategic" && !pushback) {
    pushback = {
      message: "This is a strategic-level idea. It has been flagged for Ethan review — park it and schedule time to discuss.",
      priorityRank: null,
      action: "escalate",
    };
  }

  res.json({ ok: true, classification: { ...classification, pushback, additionalContext } });
});

// Variant 5 (Normal park): notify Ethan via Slack DM that Tony parked an idea.
// Distinct from /notify-override (Variant 4) and /escalate-to-ethan (Variant 2).
router.post("/ideas/notify-park", async (req, res): Promise<void> => {
  const { text, category, urgency, ideaId } = req.body as {
    text?: string; category?: string; urgency?: string; ideaId?: string;
  };

  recordFeedback({
    agent: "ideas",
    skill: "park-normal",
    sourceType: "free_text",
    sourceId: ideaId || text || "unknown",
    rating: null,
    reviewText: null,
    snapshotExtra: { ideaText: text, category, urgency, action: "park" },
  }).catch(err => console.error("[ideas/notify-park] recordFeedback failed:", err));

  try {
    const slackText = `*Idea Parked by Tony*\n\n> ${text || "Untitled idea"}\n\n*Category:* ${category || "—"}\n*Urgency:* ${urgency || "—"}`;
    const r = await postSlackMessage({ channel: "U0991BD321Y", text: slackText });
    res.json({ ok: true, slackOk: r.ok });
  } catch (err) {
    console.warn("[ideas/notify-park] Slack DM failed:", err instanceof Error ? err.message : err);
    res.json({ ok: true, slackOk: false });
  }
});

router.post("/ideas/notify-override", async (req, res): Promise<void> => {
  const { text, justification, ideaId } = req.body as { text?: string; justification?: string; ideaId?: string };

  // New universal feedback capture — closes the lost-justification gap
  // (today the justification only goes to Slack; Coach now sees it too).
  recordFeedback({
    agent: "ideas",
    skill: "pushback",
    sourceType: "override",
    sourceId: ideaId || text || "unknown",
    rating: -1,
    reviewText: justification || null,
    snapshotExtra: { ideaText: text, justification },
  }).catch(err => console.error("[ideas/notify-override] recordFeedback failed:", err));

  // Q1 (uniform): post to #engineering channel AND DM Ethan directly so every
  // variant has a consistent personal notification surface. Tony explicitly
  // wants the DM even though Ethan is also in the channel.
  const slackText = `*Priority Override Alert*\n\nTony overrode the 90-day plan to prioritize:\n> ${text || "Unknown idea"}\n\n*Justification:* ${justification || "No justification provided"}`;
  let channelOk = false;
  let dmOk = false;
  try {
    await postSlackMessage({ channel: "C0A3CS15MPT", text: slackText });
    channelOk = true;
  } catch { /* keep going to DM */ }
  try {
    await postSlackMessage({ channel: "U0991BD321Y", text: slackText });
    dmOk = true;
  } catch { /* swallow */ }
  res.json({ ok: true, channelOk, dmOk });
});

router.post("/ideas/escalate-to-ethan", async (req, res): Promise<void> => {
  const { text, rank, reasoning, meetingStart, meetingEnd, ideaId, category, urgency } = req.body as {
    text?: string;
    rank?: number;
    reasoning?: string;
    meetingStart?: string;
    meetingEnd?: string;
    ideaId?: string;
    category?: string;
    urgency?: string;
  };

  // B5-4: capture an escalate-feedback row so Coach can learn what Tony
  // deems important enough to escalate. Fire-and-forget — do not block the
  // notify/booking flow on a feedback write.
  recordFeedback({
    agent: "ideas",
    skill: "classify",
    sourceType: "escalate",
    sourceId: ideaId || text || "unknown",
    rating: null,
    reviewText: reasoning || null,
    snapshotExtra: {
      ideaId: ideaId || null,
      ideaText: text || null,
      ideaCategory: category || null,
      ideaUrgency: urgency || null,
      reason: reasoning || null,
      aiPriorityRank: rank ?? null,
    },
  }).catch(err => console.error("[ideas/escalate-to-ethan] recordFeedback failed:", err));

  let slackOk = false;
  let calendarOk = false;
  let scheduledStart: string | null = null;
  let scheduledEnd: string | null = null;

  // ── Slack notification (fire even if calendar booking fails) ───────────────
  try {
    const r = await postSlackMessage({
      channel: "U0991BD321Y",
      text: `*Idea Parked + Meeting Requested*\n\nTony submitted an idea that was flagged as out-of-scope and auto-parked:\n> ${text || ""}\n\nPlease schedule a meeting to discuss if this should be prioritized.`,
    });
    slackOk = r.ok;
  } catch {
    slackOk = false;
  }

  // ── Calendar booking ──────────────────────────────────────────────────────
  // Honor the FE-supplied slot if both ISO timestamps validate; otherwise fall
  // back to "tomorrow at 2pm local, skipping weekends" so existing callers
  // (any without the new fields) keep working.
  try {
    const { createEvent } = await import("../../lib/gcal");

    let startDate: Date;
    let endDate: Date;
    if (meetingStart && meetingEnd) {
      startDate = new Date(meetingStart);
      endDate = new Date(meetingEnd);
    } else {
      startDate = new Date();
      startDate.setDate(startDate.getDate() + 1);
      if (startDate.getDay() === 0) startDate.setDate(startDate.getDate() + 1);
      if (startDate.getDay() === 6) startDate.setDate(startDate.getDate() + 2);
      startDate.setHours(14, 0, 0, 0);
      endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
    }

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new Error("Invalid meetingStart/meetingEnd ISO timestamps");
    }

    await createEvent({
      summary: `Review plan change with Ethan — "${(text || "").substring(0, 50)}"`,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      attendees: ["ethan@flipiq.com"],
      description: `Tony submitted: "${text}"\nAI priority: #${rank || "unknown"}\nTony's reasoning: "${reasoning || "Auto-parked, no justification"}"`,
    });
    calendarOk = true;
    scheduledStart = startDate.toISOString();
    scheduledEnd = endDate.toISOString();
  } catch (err) {
    calendarOk = false;
    console.warn("[ideas/escalate-to-ethan] calendar booking failed:", err instanceof Error ? err.message : err);
  }

  res.json({
    ok: slackOk || calendarOk,
    slackOk,
    calendarOk,
    meetingStart: scheduledStart,
    meetingEnd: scheduledEnd,
  });
});

const NotifyAssigneeBody = z.object({
  ideaText: z.string().min(1),
  category: z.string(),
  urgency: z.string(),
  dueDate: z.string(),
  assigneeName: z.string(),
  assigneeEmail: z.string().email(),
  slackUserId: z.string().optional(),
  notifyChannels: z.array(z.enum(["email", "slack"])).default(["email"]),
  note: z.string().optional(),
});

router.post("/ideas/notify-assignee", async (req, res): Promise<void> => {
  const parsed = NotifyAssigneeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { ideaText, category, urgency, dueDate, assigneeName, assigneeEmail, slackUserId, notifyChannels, note } = parsed.data;
  const results: Record<string, boolean> = {};

  try {
    if (notifyChannels.includes("email")) {
      try {
        const { sendEmail } = await import("../../lib/gmail");
        const subject = `[FlipIQ] Action Item Assigned to You: ${ideaText.substring(0, 60)}`;
        const body = [
          `Hi ${assigneeName},`,
          "",
          `Tony Diaz has assigned you an action item from FlipIQ's idea pipeline.`,
          "",
          `Idea: ${ideaText}`,
          `Category: ${category}`,
          `Urgency: ${urgency}`,
          `Due Date: ${dueDate}`,
          ...(note ? [``, `Note from Tony: ${note}`] : []),
          "",
          "Please action this by the due date.",
          "",
          "— FlipIQ Command Center",
        ].join("\n");
        const result = await sendEmail({ to: assigneeEmail, subject, body });
        results.email = result.ok;
      } catch {
        results.email = false;
      }
    }

    if (notifyChannels.includes("slack") && slackUserId) {
      try {
        const slackResult = await notifyAssigneeViaSlack({
          slackUserId,
          ideaText,
          category,
          urgency,
          dueDate,
          assigneeName,
          note,
        });
        results.slack = slackResult.ok;
      } catch {
        results.slack = false;
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    req.log.error({ err }, "notify-assignee route error");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

const CreateIdeaBody = z.object({
  text: z.string().min(1),
  category: z.string(),
  urgency: z.string(),
  techType: z.string().nullable().optional(),
  assigneeName: z.string().optional(),
  assigneeEmail: z.string().email().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  aiReflection: z.string().optional(), // JSON string of AI classification result
});

router.post("/ideas", async (req, res): Promise<void> => {
  const parsed = CreateIdeaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { text, category, urgency, techType, assigneeName, assigneeEmail, dueDate, aiReflection } = parsed.data;

  const existingIdeas = await db.select().from(ideasTable).orderBy(desc(ideasTable.createdAt));
  const priorityPosition = existingIdeas.length + 1;

  const [idea] = await db
    .insert(ideasTable)
    .values({
      text,
      category,
      urgency,
      techType: techType ?? undefined,
      priorityPosition,
      status: "parked",
      assigneeName: assigneeName || undefined,
      assigneeEmail: assigneeEmail || undefined,
      dueDate: dueDate || undefined,
      aiReflection: aiReflection || undefined,
    })
    .returning();

  let linearIssue: { id?: string; identifier?: string; ok: boolean } = { ok: false };

  if (category === "Tech") {
    // 1. Create Linear issue
    try {
      const priorityMap: Record<string, number> = { "Now": 1, "This Week": 2, "This Month": 3, "Someday": 4 };
      linearIssue = await createLinearIssue({
        title: text,
        description: `**FlipIQ Tech Idea** parked by Tony via Command Center\n\nType: ${techType || "Idea"}\nUrgency: ${urgency}\nPriority Position: #${priorityPosition}`,
        priority: priorityMap[urgency] ?? 3,
      });
      if (linearIssue.ok) {
        req.log.info({ identifier: linearIssue.identifier }, "Created Linear issue");
        if (linearIssue.identifier) {
          await db.update(ideasTable).set({ linearIdentifier: linearIssue.identifier }).where(eq(ideasTable.id, idea.id)).catch(() => {});
        }
      }
    } catch (err) {
      req.log.warn({ err }, "Linear issue creation failed");
    }

    // 2. Post to Slack #tech-ideas via Claude's Slack tool infrastructure (fire and forget)
    notifyTechIdeaViaClaude({
      text,
      urgency,
      techType: techType ?? null,
      linearIdentifier: linearIssue.identifier,
    }).catch(err => console.error("[ideas] Slack notification failed:", err));
  }

  res.status(201).json({
    ...idea,
    linearIssue: linearIssue.ok ? { id: linearIssue.id, identifier: linearIssue.identifier } : null,
  });
});

// ─── Generate task fields from an approved idea via AI ────────────────────────
router.post("/ideas/generate-task", async (req, res): Promise<void> => {
  try {
    const { ideaText, category, urgency, techType } = req.body as {
      ideaText: string; category: string; urgency: string; techType?: string;
    };
    if (!ideaText) { res.status(400).json({ error: "ideaText required" }); return; }

    const bizContext = await getBusinessContext();

    const userPrompt = `Idea category: ${category}\nUrgency: ${urgency}${techType ? `\nType: ${techType}` : ""}\n\nIdea: "${ideaText}"\n\nGenerate task fields.`;
    const legacySystem = `You are the FlipIQ task creation assistant. Given an idea, generate structured task fields for the 411 Plan.

Available categories and their subcategories:
- adaptation: Operator Assessment, CS Dashboard, User Outreach, Success Playbook, Dead Weight Suspension
- sales: Pricing & Approach, Commitments Pipeline, Demo Workflow, Sales Materials, Prospect Pipeline
- tech: CS Dashboard (Tech), Foundation + DispoPro, AWS/Cloud Credits, AAA Build, USale Marketplace
- capital: Loan Direction Decision, P&L / Financial Plan, Investor Meetings, Kiavi Broker, Nema/Lightning Docs
- team: PM/Engineer Hire, Onboarding Manager, Adaptation Manager, Nate Transition, SOW Updates

Owners: Tony, Ethan, Ramy, Faisal, Haris, Nate, Bondilyn, Chris, TBD PM
Priorities: P0 (critical, blocks revenue today), P1 (high, must ship this week), P2 (standard, this sprint)
Execution tiers: Sprint (weekly deliverable), Strategic (multi-week initiative), Maintenance (ongoing)
Sources: OAP, Linear, TCC, manual

Business context:
${bizContext}

Return ONLY valid JSON with these exact fields:
{
  "title": "Owner: action description",
  "category": "adaptation|sales|tech|capital|team",
  "subcategoryName": "exact subcategory name from list above",
  "owner": "Tony|Ethan|Ramy|Faisal|Haris|Nate|Bondilyn|Chris|TBD PM",
  "coOwner": "Tony|Ethan|Ramy|Faisal|Haris|Nate|Bondilyn|Chris|TBD PM|null",
  "priority": "P0|P1|P2",
  "executionTier": "Sprint|Strategic|Maintenance",
  "atomicKpi": "how this moves toward 2 deals/month",
  "source": "TCC",
  "workNotes": "context from the original idea"
}

Set coOwner to whoever should support the primary owner based on idea domain and team expertise. Use null if no clear second owner.`;

    let raw = "";

    // Flag-gated: AGENT_RUNTIME_IDEAS=true routes through runtime.
    // Runtime path sends only data — task-creation rules (categories,
    // subcategories, owners, format) live in the skill body (loaded as L3).
    if (isAgentRuntimeEnabled("ideas")) {
      const runtimeMessage = `Business context:\n${bizContext}\n\n${userPrompt}`;
      const result = await runAgent("ideas", "generate-task", {
        userMessage: runtimeMessage,
        caller: "direct",
        meta: { ideaCategory: category, urgency },
      });
      raw = result.text;
    } else {
      const claudeResponse = await createTrackedMessage("idea_classify", {
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: legacySystem,
        messages: [{ role: "user", content: userPrompt }],
      });
      const textBlock = claudeResponse.content.find(b => b.type === "text");
      if (!textBlock || textBlock.type !== "text") { res.json({ ok: false, error: "No response" }); return; }
      raw = textBlock.text;
    }

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { res.json({ ok: false, error: "No JSON in AI response" }); return; }

    const taskFields = JSON.parse(jsonMatch[0]);
    // Ensure source is always TCC for idea-generated tasks
    taskFields.source = "TCC";
    // Map urgency to due date if not set
    if (!taskFields.dueDate) {
      const now = new Date();
      if (urgency === "Now") taskFields.dueDate = now.toISOString().split("T")[0];
      else if (urgency === "This Week") {
        const fri = new Date(now); fri.setDate(fri.getDate() + (5 - fri.getDay())); taskFields.dueDate = fri.toISOString().split("T")[0];
      } else if (urgency === "This Month") {
        const eom = new Date(now.getFullYear(), now.getMonth() + 1, 0); taskFields.dueDate = eom.toISOString().split("T")[0];
      }
    }

    res.json({ ok: true, taskFields });
  } catch (err) {
    console.warn("[Ideas] generate-task failed:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to generate task fields" });
  }
});

// ─── PATCH /ideas/:id — edit an idea ──────────────────────────────────────────
router.patch("/ideas/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;
  const updateFields: Record<string, unknown> = {};
  if ("text" in body) updateFields.text = String(body.text);
  if ("category" in body) updateFields.category = String(body.category);
  if ("urgency" in body) updateFields.urgency = String(body.urgency);
  if ("techType" in body) updateFields.techType = body.techType ? String(body.techType) : null;
  if ("status" in body) updateFields.status = String(body.status);
  if ("assigneeName" in body) updateFields.assigneeName = body.assigneeName ? String(body.assigneeName) : null;
  if ("assigneeEmail" in body) updateFields.assigneeEmail = body.assigneeEmail ? String(body.assigneeEmail) : null;
  if ("dueDate" in body) updateFields.dueDate = body.dueDate ? String(body.dueDate) : null;
  if ("aiReflection" in body) updateFields.aiReflection = body.aiReflection ? String(body.aiReflection) : null;

  try {
    const [updated] = await db.update(ideasTable).set(updateFields).where(eq(ideasTable.id, id)).returning();
    if (!updated) { res.status(404).json({ error: "Idea not found" }); return; }
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── DELETE /ideas/:id — delete an idea ──────────────────────────────────────
router.delete("/ideas/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    const [deleted] = await db.delete(ideasTable).where(eq(ideasTable.id, id)).returning({ id: ideasTable.id });
    if (!deleted) { res.status(404).json({ error: "Idea not found" }); return; }
    res.json({ ok: true, id: deleted.id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// HTML-escape user-controlled strings before interpolating into an email
// body. Covers the three chars that can break out of text context into
// markup; intentionally narrow (no quotes) because we never interpolate
// into attribute values.
function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] || c));
}

// ─── Reflection summary helper — formats the persisted AI classification
// JSON (Category / Urgency / Type / Priority / Reason / Business Fit) into
// a concise multi-line string used by both the Slack DM and Resend email
// payloads. Falls back to "no AI reflection on file yet" when the column
// is empty or unparseable.
function buildReflectionSummary(idea: typeof ideasTable.$inferSelect): string {
  let parsed: Record<string, unknown> = {};
  if (idea.aiReflection) {
    try { parsed = JSON.parse(idea.aiReflection) as Record<string, unknown>; }
    catch { /* fall through — emit a minimal summary */ }
  }
  const lines = [
    `Idea: ${idea.text}`,
    `Category: ${(parsed.category as string) || idea.category || "—"}`,
    `Urgency: ${(parsed.urgency as string) || idea.urgency || "—"}`,
    `Type: ${(parsed.techType as string) || idea.techType || "—"}`,
    `Priority: ${(parsed.priority as string) || "—"}`,
  ];
  if (parsed.reason) lines.push(`Reason: ${parsed.reason}`);
  if (parsed.businessFit) lines.push(`Business fit: ${parsed.businessFit}`);
  return lines.join("\n");
}

// ─── POST /ideas/:id/notify-assignee-slack — DM the assignee with reflection ─
// Looks up the assignee in team_roles (by name first, falling back to email)
// and DMs their Slack ID with the persisted AI reflection summary. Returns
// a structured 4xx body when the assignee or their Slack ID is missing so
// the FE can surface a tooltip-friendly reason.
router.post("/ideas/:id/notify-assignee-slack", async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    const [idea] = await db.select().from(ideasTable).where(eq(ideasTable.id, id)).limit(1);
    if (!idea) { res.status(404).json({ ok: false, error: "Idea not found" }); return; }
    if (!idea.assigneeName && !idea.assigneeEmail) {
      res.status(400).json({ ok: false, error: "no_assignee" });
      return;
    }

    // Try team_roles match (canonical Slack ID). Match name first (exact),
    // then email (case-insensitive). Fall back to a Slack workspace lookup
    // by display-name/email so users not yet in team_roles still notify.
    const roles = await db.select().from(teamRolesTable);
    const byName = roles.find(r => idea.assigneeName && r.name.toLowerCase() === idea.assigneeName.toLowerCase());
    const byEmail = idea.assigneeEmail
      ? roles.find(r => r.email && r.email.toLowerCase() === idea.assigneeEmail!.toLowerCase())
      : null;
    let slackId = byName?.slackId || byEmail?.slackId || null;

    if (!slackId) {
      try {
        const slackRes = await listSlackUsers();
        const members = slackRes.members ?? [];
        const matchEmail = idea.assigneeEmail?.toLowerCase();
        const matchName = idea.assigneeName?.toLowerCase();
        const su = members.find(m =>
          (matchEmail && m.profile?.email?.toLowerCase() === matchEmail) ||
          (matchName && (m.profile?.display_name?.toLowerCase() === matchName || m.real_name?.toLowerCase() === matchName))
        );
        slackId = su?.id || null;
      } catch { /* slack lookup failed — fall through to error */ }
    }

    if (!slackId) {
      res.status(400).json({ ok: false, error: "no_slack_id" });
      return;
    }

    const summary = buildReflectionSummary(idea);
    const slackText = `💡 *Idea reflection from Tony*\n\n${summary}`;
    const r = await postSlackMessage({ channel: slackId, text: slackText });
    if (!r.ok) {
      res.status(502).json({ ok: false, error: r.error || "slack_failed" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── POST /ideas/:id/notify-assignee-email — Resend the assignee a reflection
// Subject is "Idea reflection: <title>"; body is the persisted reflection
// summary as plain-text-in-HTML (newlines preserved via <pre>).
router.post("/ideas/:id/notify-assignee-email", async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    const [idea] = await db.select().from(ideasTable).where(eq(ideasTable.id, id)).limit(1);
    if (!idea) { res.status(404).json({ ok: false, error: "Idea not found" }); return; }
    if (!idea.assigneeEmail) {
      res.status(400).json({ ok: false, error: "no_email" });
      return;
    }

    const summary = buildReflectionSummary(idea);
    const titleSnippet = idea.text.substring(0, 60) + (idea.text.length > 60 ? "..." : "");
    const subject = `Idea reflection: ${titleSnippet}`;
    // Plain-text version (Gmail multipart fallback). Used by clients that
    // can't render HTML and as the safer default.
    const plainBody = `Hi ${idea.assigneeName || "there"},\n\nTony shared an AI reflection on this idea:\n\n${summary}\n\n— FlipIQ Command Center`;
    // HTML version. Both assigneeName and summary are user/AI-controlled
    // strings rendered into HTML — escape them to prevent markup injection.
    const safeName = escapeHtml(idea.assigneeName || "there");
    const safeSummary = escapeHtml(summary);
    const htmlBody = `<p>Hi ${safeName},</p>
<p>Tony shared an AI reflection on this idea:</p>
<pre style="background:#F9FAFB;padding:12px;border-radius:6px;font-family:monospace;white-space:pre-wrap;">${safeSummary}</pre>
<p>— FlipIQ Command Center</p>`;

    const { sendSystemEmail } = await import("../../lib/agentmail");
    const r = await sendSystemEmail({ to: idea.assigneeEmail, subject, body: plainBody, html: htmlBody });
    if (!r.ok) {
      // Surface the upstream Gmail error so the FE can show something
      // actionable (auth expired, recipient invalid, quota, etc.).
      res.status(502).json({ ok: false, error: r.error || "email_failed", status: r.status });
      return;
    }
    res.json({ ok: true, messageId: r.messageId });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── POST /ideas/:id/rethink — re-classify an existing idea via AI ──────────
router.post("/ideas/:id/rethink", async (req, res): Promise<void> => {
  const { id } = req.params;
  try {
    const [idea] = await db.select().from(ideasTable).where(eq(ideasTable.id, id)).limit(1);
    if (!idea) { res.status(404).json({ error: "Idea not found" }); return; }

    // Re-classify using the same AI flow
    const recentIdeas = await db.select().from(ideasTable).orderBy(desc(ideasTable.createdAt)).limit(5);
    const classification = await classifyIdea(idea.text, recentIdeas);

    // Update idea with new classification — persist the full reflection
    // JSON too so the drawer's AI tab can re-show it without re-running
    // the classifier on every reopen.
    const [updated] = await db.update(ideasTable).set({
      category: classification.category,
      urgency: classification.urgency,
      techType: classification.techType || null,
      aiReflection: JSON.stringify(classification),
    }).where(eq(ideasTable.id, id)).returning();

    res.json({ ok: true, idea: updated, classification });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
