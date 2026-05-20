import { Router, type IRouter } from "express";
import { gte } from "drizzle-orm";
import { db, callLogTable, ideasTable } from "@workspace/db";
import { createEvent } from "../../lib/gcal.js";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { postSlackMessage } from "../../lib/slack.js";
import z from "zod";
import { recordFeedback } from "../../agents/feedback.js";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";

const router: IRouter = Router();

const CALL_QUOTA = 10;
const CALL_START_MIN = 9 * 60;   // 9:00 AM
const CALL_END_MIN   = 16 * 60;  // 4:00 PM

function timeToMinutes(t: string): number | null {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}

function getPacificOffset(dateStr: string): string {
  // Determine whether the given date falls in PDT (UTC-7) or PST (UTC-8)
  // PDT: 2nd Sunday of March 2 AM → 1st Sunday of November 2 AM
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  // 2nd Sunday of March
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const marchSecondSun = new Date(Date.UTC(year, 2,
    (marchFirst.getUTCDay() === 0 ? 8 : 15 - marchFirst.getUTCDay())));
  // 1st Sunday of November
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const novFirstSun = new Date(Date.UTC(year, 10,
    (novFirst.getUTCDay() === 0 ? 1 : 8 - novFirst.getUTCDay())));
  return d >= marchSecondSun && d < novFirstSun ? "-07:00" : "-08:00";
}

function buildISO(date: string, time: string): string {
  // date = YYYY-MM-DD, time = HH:MM (24h)
  return `${date}T${time}:00${getPacificOffset(date)}`;
}

async function getTodayCallCount(): Promise<number> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const calls = await db.select().from(callLogTable).where(gte(callLogTable.createdAt, today));
    return calls.length;
  } catch { return 0; }
}

const CATEGORY_COLOR_ID: Record<string, string> = {
  "TECH":           "9",  // Basil (dark green)
  "OPERATIONS":     "4",  // Flamingo (salmon)
  "DONE":           "11", // Graphite (gray)
  "FINANCE":        "1",  // Lavender (blue-purple)
  "IMPORTANT":      "10", // Tomato (red)
  "PROJECTS":       "5",  // Banana (yellow)
  "PERSONAL":       "3",  // Grape (purple)
  "MEETING":        "6",  // Tangerine (orange)
  "NEEDS PLANNING": "8",  // Blueberry (indigo)
  "SALES Tech":     "2",  // Sage (light green)
};

// ── Scope gatekeeper ─────────────────────────────────────────────────────────
// Priority: Sales activities > Ramy (CSM ops) > Ethan (COO ops) > Other
async function checkMeetingScope(title: string, description?: string): Promise<{
  inScope: boolean;
  category: "Sales" | "CSM" | "COO" | "Other";
  warning?: string;
}> {
  try {
    let raw = "";

    // Flag-gated: AGENT_RUNTIME_SCHEDULE=true routes through runtime;
    // default false keeps legacy inline call intact.
    if (isAgentRuntimeEnabled("schedule")) {
      const userMessage = `Meeting: "${title}"${description ? `\nDescription: "${description}"` : ""}`;
      const result = await runAgent("schedule", "check-scope", {
        userMessage,
        caller: "direct",
        meta: { title },
      });
      raw = result.text;
    } else {
      const msg = await createTrackedMessage("schedule_optimize", {
        model: "claude-haiku-4-5",
        max_tokens: 256,
        messages: [{
          role: "user",
          content: `You are Tony Diaz's scheduling gatekeeper for FlipIQ, a real estate wholesale platform.
Tony's daily priority: 10 Sales Calls first, then demos/follow-ups, then everything else.
Classify this meeting and return ONLY valid JSON.

Meeting: "${title}"${description ? `\nDescription: "${description}"` : ""}

Categories (in priority order):
- "Sales": Sales calls, demos, investor calls, buyer/seller conversations, acquisition calls
- "CSM": Ramy-related ops, OMS, title company, compliance, customer success
- "COO": Ethan-related ops, investor updates, legal, finance, hiring, Linear/engineering review
- "Other": Everything else — could distract from core revenue activities

Return: {"inScope": true/false, "category": "Sales|CSM|COO|Other", "warning": "optional one-line warning if Other"}
inScope = false ONLY if category is "Other" AND it seems like a distraction from revenue.
Return ONLY the JSON, no markdown.`
        }]
      });
      const block = msg.content[0];
      if (block.type !== "text") return { inScope: true, category: "Other" };
      raw = block.text;
    }

    const parsed = JSON.parse(raw.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, ""));
    // v2 schedule/check-scope skill emits {scope, warning}; legacy shape is {inScope, category, warning}.
    // Map v2 scope (sales|ops|personal|other) → legacy category (Sales|CSM|COO|Other) and derive inScope.
    const SCOPE_TO_CATEGORY: Record<string, "Sales" | "CSM" | "COO" | "Other"> = {
      sales: "Sales", ops: "CSM", personal: "Other", other: "Other",
    };
    const v2Scope = typeof parsed.scope === "string" ? parsed.scope.toLowerCase() : null;
    const category = parsed.category ?? (v2Scope ? SCOPE_TO_CATEGORY[v2Scope] ?? "Other" : "Other");
    const inScope = parsed.inScope ?? (category !== "Other" || !parsed.warning);
    return { inScope, category, warning: parsed.warning };
  } catch {
    return { inScope: true, category: "Other" }; // fail open
  }
}

const ETHAN_SLACK_USER = "ethan"; // will DM via Slack if we can find his ID

const AddEventBody = z.object({
  title: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  allDay: z.boolean().optional().default(false),
  startTime: z.string().optional(),  // HH:MM (24h)
  endTime: z.string().optional(),    // HH:MM (24h)
  location: z.string().optional(),
  description: z.string().optional(),
  notification: z.number().optional().default(10), // minutes
  guests: z.array(z.string()).optional().default([]),
  forceOverride: z.boolean().optional().default(false),
  overrideReason: z.string().optional(),
  category: z.string().optional(),
  priority: z.string().optional(),
});

router.post("/schedule/add", async (req, res): Promise<void> => {
  const parsed = AddEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { title, date, allDay, startTime, endTime, location, description, notification, guests, forceOverride, overrideReason, category, priority } = parsed.data;
  const colorId = category ? CATEGORY_COLOR_ID[category] : undefined;

  // Defense-in-depth: timed events must have start < end. Without this we
  // hit a generic 500 from Google Calendar with no actionable message.
  if (!allDay && startTime && endTime) {
    const sMin = timeToMinutes(startTime);
    const eMin = timeToMinutes(endTime);
    if (sMin !== null && eMin !== null && eMin <= sMin) {
      res.status(400).json({ ok: false, error: "End time must be after start time." });
      return;
    }
  }

  // ── Guilt-trip check (only for timed events during call hours) ───────────
  let guiltTrip = false;
  let guiltTripMsg = "";
  let callsMade = 0;

  if (!allDay && !forceOverride && startTime) {
    const eventMin = timeToMinutes(startTime);
    if (eventMin !== null && eventMin >= CALL_START_MIN && eventMin < CALL_END_MIN) {
      callsMade = await getTodayCallCount();
      if (callsMade < CALL_QUOTA) {
        guiltTrip = true;
        guiltTripMsg = `You're scheduling "${title}" at ${startTime} during call hours and you've only made ${callsMade} of ${CALL_QUOTA} calls today. This will be flagged in your EOD report.`;
      }
    }
  }

  if (guiltTrip && !forceOverride) {
    res.json({ ok: false, guiltTrip: true, guiltTripMsg, callsMade, quotaTarget: CALL_QUOTA });
    return;
  }

  // ── Scope gatekeeper (AI check — fires in parallel, non-blocking) ─────────
  let scopeWarning: string | undefined;
  let scopeCategory = "Other";
  if (!allDay) {
    const scope = await checkMeetingScope(title, description).catch(() => ({ inScope: true, category: "Other", warning: undefined as string | undefined }));
    scopeCategory = scope.category;
    if (!scope.inScope && !forceOverride) {
      res.json({
        ok: false, scopeBlock: true,
        scopeMsg: scope.warning || `"${title}" doesn't look like a Sales or ops meeting. Your North Star is 10 calls/day. Force override?`,
        scopeCategory: scope.category,
        callsMade, quotaTarget: CALL_QUOTA,
      });
      return;
    }
    if (!scope.inScope && forceOverride) {
      scopeWarning = scope.warning;
      // Notify Ethan via Slack that Tony force-overrode an out-of-scope meeting
      postSlackMessage({
        channel: "U0991BD321Y",
        text: `⚠️ Tony force-overrode a non-Sales meeting: *${title}* on ${date}${startTime ? ` at ${startTime}` : ""}\n_${scope.warning || "Flagged as out-of-scope by AI gatekeeper"}_`,
      }).catch(() => { /* non-critical */ });
    }
  }

  // ── Build Google Calendar event ──────────────────────────────────────────
  let gcalStart: string;
  let gcalEnd: string;

  if (allDay) {
    gcalStart = date;
    gcalEnd = date;
  } else {
    gcalStart = buildISO(date, startTime || "09:00");
    gcalEnd   = buildISO(date, endTime   || "10:00");
  }

  const descParts = [];
  if (priority) descParts.push(`Priority: ${priority}`);
  if (description) descParts.push(description);

  const gcalResult = await createEvent({
    summary: title,
    start: gcalStart,
    end: gcalEnd,
    allDay,
    attendees: guests.length > 0 ? guests : undefined,
    description: descParts.join("\n\n") || undefined,
    location: location,
    colorId,
  });

  if (!gcalResult.ok) {
    res.status(500).json({ ok: false, error: gcalResult.error || "Failed to create Google Calendar event" });
    return;
  }

  // ── Log forced override to EOD ────────────────────────────────────────────
  if (forceOverride && guiltTripMsg) {
    const overrideText = `⚠️ FORCED MEETING: ${title} at ${startTime} on ${date} | Calls: ${callsMade}/${CALL_QUOTA}`;
    await db.insert(ideasTable).values({
      text: overrideText,
      category: "accountability",
      urgency: "high",
      status: "override",
    }).catch(() => { /* non-critical */ });
  }

  // New universal feedback capture — runs whenever Tony force-overrides
  // either the guilt-trip OR the scope-gatekeeper. The reason field (added
  // to AddEventBody) carries Tony's explanation when the FE supplies it.
  // Awaited so the FE Train-now toast can deep-link to this exact row.
  let feedbackId: string | undefined;
  if (forceOverride) {
    try {
      const fb = await recordFeedback({
        agent: "schedule",
        skill: "check-scope",
        sourceType: "override",
        sourceId: gcalResult.eventId || `${date}T${startTime || ""}`,
        reviewText: overrideReason || guiltTripMsg || scopeWarning || null,
        snapshotExtra: {
          title, date, startTime,
          scope: scopeCategory,
          scopeWarning,
          callsMade,
          quotaTarget: CALL_QUOTA,
        },
      });
      feedbackId = fb.feedbackId;
    } catch (err) { console.error("[schedule/add] recordFeedback failed:", err); }
  }

  res.json({ ok: true, eventId: gcalResult.eventId, htmlLink: gcalResult.htmlLink, feedback_id: feedbackId });
});

export default router;
