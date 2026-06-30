import { Router, type IRouter } from "express";
import { eq, gte, sql } from "drizzle-orm";
import { sharedDb, personalDb, eodReportsTable, callLogTable, demosTable, ideasTable, taskCompletionsTable } from "@workspace/db";
import { planItemsTable } from "../../lib/schema-v2";
import { linearGraphQL } from "../../lib/linear";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { sendEmail } from "../../lib/gmail";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";
import { todayPacific } from "../../lib/dates.js";
import { communicationLogTable, businessContextTable } from "../../lib/schema-v2";

const router: IRouter = Router();

router.get("/eod-report/today", async (req, res): Promise<void> => {
  const today = todayPacific();
  const [report] = await personalDb.select().from(eodReportsTable).where(eq(eodReportsTable.date, today));
  res.json(report || null);
});

// ── Helper: build EOD stats + AI text ─────────────────────────────────────────
async function buildEodReport(log: any): Promise<{ reportText: string; callsMade: number; demosBooked: number; tasksCompleted: number; }> {
  const today = todayPacific();
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);

  const [calls, demoRows, planCompletions] = await Promise.all([
    sharedDb.select().from(callLogTable).where(gte(callLogTable.createdAt, todayDate)),
    sharedDb.select().from(demosTable).where(eq(demosTable.scheduledDate, today)),
    sharedDb.select().from(planItemsTable).where(
      sql`${planItemsTable.status} = 'completed' AND ${planItemsTable.completedAt} >= ${todayDate} AND ${planItemsTable.level} = 'task'`
    ),
  ]);

  const callsMade = calls.length;
  const demosBooked = demoRows.length;
  const tasksCompleted = planCompletions.length;
  const callList = calls.map(c => `- ${c.contactName}: ${c.type}`).join("\n") || "- No calls logged";
  const taskList = planCompletions.map(t => `- ${t.title} (${t.category || "misc"})`).join("\n") || "- No tasks completed";

  let reportText = "";
  try {
    // Flag-gated: AGENT_RUNTIME_BRIEF=true routes through runtime.
    // Runtime path sends only dynamic data; format/voice rules live in skill body.
    if (isAgentRuntimeEnabled("brief")) {
      const runtimeMessage = `Today's Data:
- Calls Made: ${callsMade}
- Demos Booked: ${demosBooked}
- Tasks Completed: ${tasksCompleted}

Call Log:
${callList}

Tasks Completed:
${taskList}`;

      const result = await runAgent("brief", "eod-preview", {
        userMessage: runtimeMessage,
        caller: "direct",
        meta: { callsMade, demosBooked, tasksCompleted },
      });
      reportText = result.text;
    } else {
      const eodPreviewPrompt = `Generate an EOD (End of Day) report for ${process.env.TCC_USER_NAME || "Tony Diaz"}, ${process.env.TCC_USER_ROLE || "CEO"} of FlipIQ.

Today's Data:
- Calls Made: ${callsMade}
- Demos Booked: ${demosBooked}
- Tasks Completed: ${tasksCompleted}

Call Log:
${callList}

Tasks Completed:
${taskList}

Write a brief EOD report (3-4 paragraphs) in ${process.env.TCC_USER_NAME || "Tony"}'s voice:
1. Summary of the day's sales activity
2. Key wins and opportunities identified
3. What needs follow-up tomorrow
4. One motivating closing thought

Keep it honest, direct, and actionable.`;
      const message = await createTrackedMessage("eod_preview", {
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        messages: [{ role: "user", content: eodPreviewPrompt }],
      });
      const block = message.content[0];
      if (block.type === "text") reportText = block.text;
    }
  } catch (err) {
    log?.warn?.({ err }, "Claude EOD report generation failed");
    reportText = `EOD Report — ${today}\n\nCalls Made: ${callsMade}\nDemos Booked: ${demosBooked}\nTasks Completed: ${tasksCompleted}\n\n${callList}\n\nKeep pushing forward tomorrow.`;
  }

  return { reportText, callsMade, demosBooked, tasksCompleted };
}

// ── Preview — generate without sending ────────────────────────────────────────
router.post("/eod-report/preview", async (req, res): Promise<void> => {
  const data = await buildEodReport(req.log);
  res.json({ ok: true, ...data });
});

router.post("/eod-report", async (req, res): Promise<void> => {
  const today = todayPacific();

  // If body text + recipient provided, use them directly; otherwise generate.
  // `subject` is optional — falls back to the canonical EOD subject so the
  // email never lands without one (Bug 14).
  const { to: customTo, body: customBody, subject: customSubject } = req.body ?? {};

  let reportText: string;
  let callsMade: number;
  let demosBooked: number;
  let tasksCompleted: number;

  if (customBody) {
    reportText = customBody;
    // Still pull stats for storage
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const [calls, demoRows, taskCompletions] = await Promise.all([
      sharedDb.select().from(callLogTable).where(gte(callLogTable.createdAt, todayDate)),
      sharedDb.select().from(demosTable).where(eq(demosTable.scheduledDate, today)),
      personalDb.select().from(taskCompletionsTable).where(gte(taskCompletionsTable.completedAt, todayDate)),
    ]);
    callsMade = calls.length;
    demosBooked = demoRows.length;
    tasksCompleted = taskCompletions.length;
  } else {
    ({ reportText, callsMade, demosBooked, tasksCompleted } = await buildEodReport(req.log));
  }

  const recipients: string[] = customTo ? [customTo] : [process.env.TCC_USER_EMAIL || "tony@flipiq.com"];
  const subject = (typeof customSubject === "string" && customSubject.trim())
    ? customSubject.trim()
    : `EOD Report — ${today}`;
  const sentResults = await Promise.all(
    recipients.map(async to => {
      const result = await sendEmail({
        to,
        subject,
        body: reportText,
      });
      if (!result.ok) req.log.warn({ to }, "Gmail EOD send failed");
      return { to, ok: result.ok };
    })
  );

  const sentTo = sentResults.filter(r => r.ok).map(r => r.to).join(",") || "failed";

  const [report] = await personalDb
    .insert(eodReportsTable)
    .values({ date: today, callsMade, demosBooked, tasksCompleted, reportText, sentTo })
    .onConflictDoUpdate({
      target: eodReportsTable.date,
      set: { callsMade, demosBooked, tasksCompleted, reportText, sentTo },
    })
    .returning();

  res.json({ ...report, ok: true, emailsSent: sentResults });
});

// ── Shared auto-EOD logic (also called by Claude tool) ────────────────────────
export async function sendAutoEod(): Promise<{ ok: boolean; alreadySent?: boolean; error?: string; callsMade?: number; demosBooked?: number; tasksCompleted?: number }> {
  const today = todayPacific();

  const [existing] = await personalDb.select().from(eodReportsTable).where(eq(eodReportsTable.date, today));
  if (existing) return { ok: true, alreadySent: true };

  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);

  const [calls, demoRows, planCompletions] = await Promise.all([
    sharedDb.select().from(callLogTable).where(gte(callLogTable.createdAt, todayDate)),
    sharedDb.select().from(demosTable).where(eq(demosTable.scheduledDate, today)),
    sharedDb.select().from(planItemsTable).where(
      sql`${planItemsTable.status} = 'completed' AND ${planItemsTable.completedAt} >= ${todayDate} AND ${planItemsTable.level} = 'task'`
    ),
  ]);

  let emailsSent = 0;
  try {
    const emailLogs = await sharedDb.select().from(communicationLogTable).where(gte(communicationLogTable.createdAt, todayDate));
    emailsSent = emailLogs.filter(e => e.direction === "outbound").length;
  } catch { /* non-critical */ }

  let ideasToday: string[] = [];
  try {
    const ideas = await personalDb.select().from(ideasTable).where(gte(ideasTable.createdAt, todayDate));
    ideasToday = ideas.map(i => i.text || "");
  } catch { /* non-critical */ }

  let overridesToday: string[] = [];
  try {
    const overrides = await personalDb.select().from(ideasTable)
      .where(sql`${ideasTable.createdAt} >= ${todayDate} AND ${ideasTable.status} = 'override'`);
    overridesToday = overrides.map(o => o.text || "");
  } catch { /* non-critical */ }

  let outOfSequenceItems: string[] = [];
  try {
    const linearData = await linearGraphQL<{ issues?: { nodes: { id: string; title: string; priority: number; state: { name: string; type: string } }[] } }>(
      `query {
        issues(filter: { state: { type: { nin: ["completed", "cancelled"] } } }, first: 50, orderBy: updatedAt) {
          nodes { id title priority state { name type } }
        }
      }`
    );
    const linearIssues = linearData?.issues?.nodes ?? [];
    const highPriorityStates = ["In Progress", "In Review"];
    outOfSequenceItems = linearIssues
      .filter(i => i.priority > 2 && highPriorityStates.some(s => i.state.name.includes(s)))
      .map(i => `${i.title} (priority ${i.priority}, state: ${i.state.name})`);
  } catch { /* non-critical */ }

  let noDueDateItems: string[] = [];
  try {
    const linearNoDue = await linearGraphQL<{ issues?: { nodes: { id: string; title: string }[] } }>(
      `query {
        issues(filter: { dueDate: { null: true }, state: { type: { nin: ["completed", "cancelled"] } } }, first: 50) {
          nodes { id title }
        }
      }`
    );
    noDueDateItems = (linearNoDue?.issues?.nodes ?? []).map(i => i.title);
  } catch { /* non-critical */ }

  let demoFeedback: string[] = [];
  try {
    const { analyzeDemoRecording } = await import("../../lib/demo-feedback");
    const { listTodayEvents } = await import("../../lib/gcal");
    const todayEvents = await listTodayEvents();
    const demoEvents = todayEvents.filter(e =>
      e.summary.toLowerCase().includes("flipiq demo") && new Date(e.end) < new Date()
    );
    for (const demoEvent of demoEvents) {
      const feedback = await analyzeDemoRecording(demoEvent.summary, today);
      if (feedback) demoFeedback.push(feedback);
    }
  } catch { /* non-critical */ }

  const callsMade = calls.length;
  const demosBooked = demoRows.length;
  const tasksCompleted = planCompletions.length;
  const callList = calls.map(c => `- ${c.contactName}: ${c.type}`).join("\n") || "- No calls logged";
  const taskList = planCompletions.map(t => `- ${t.title} (${t.category || "misc"})`).join("\n") || "- No tasks completed";
  const completionRate = Math.min(100, Math.round((tasksCompleted / 10) * 100));

  // Build the recipient-specific user prompts. The plan calls for one
  // skill (eod-report) with a `recipient` param — both Tony's and Ethan's
  // EODs use the same skill but different user prompts.
  //
  // For each recipient: legacy variant has full instructions; runtime variant
  // has only dynamic data (skill body has the format/voice rules).

  const userName = process.env.TCC_USER_NAME || "Tony Diaz";
  const userFirstName = userName.split(/\s+/)[0];
  const userRole = process.env.TCC_USER_ROLE || "CEO";
  const userEmail = process.env.TCC_USER_EMAIL || "tony@flipiq.com";
  const accountabilityEmail = process.env.TCC_ACCOUNTABILITY_EMAIL || "ethan@flipiq.com";

  // ── User's own EOD ──
  const userDataOnly = `Recipient: ${userFirstName} (date ${today}).

Today's Data:
- Calls made: ${callsMade}
- Demos booked/completed: ${demosBooked}
- Emails sent: ${emailsSent}
- Tasks completed: ${tasksCompleted}
- Tasks completed today:\n${taskList}
- Ideas submitted: ${ideasToday.length > 0 ? ideasToday.join(", ") : "None"}`;

  const userPromptLegacy = `Generate ${userName}'s EOD report for ${today} (FlipIQ ${userRole}).

Today's Data:
- Calls made: ${callsMade}
- Demos booked/completed: ${demosBooked}
- Emails sent: ${emailsSent}
- Tasks completed: ${tasksCompleted}
- Tasks completed today:\n${taskList}
- Ideas submitted: ${ideasToday.length > 0 ? ideasToday.join(", ") : "None"}

Format as a brief EOD (4 paragraphs max):
1. Quick summary
2. Key metrics: calls, demos, tasks
3. What needs follow-up tomorrow
4. One closing thought in ${userFirstName}'s voice — direct and honest.`;

  // ── Accountability EOD (sent to accountability partner) ──
  const accountabilityName = (accountabilityEmail.split("@")[0] || "Accountability").replace(/^\w/, c => c.toUpperCase());
  const accountabilityDataOnly = `Recipient: ${accountabilityName} (date ${today}).

${userFirstName}'s Activity:
- Calls: ${callsMade}, Demos: ${demosBooked}, Emails: ${emailsSent}
- Tasks completed: ${tasksCompleted}
- Accountability score: ${completionRate}%

Items Without Due Dates (${accountabilityName} must assign):
${noDueDateItems.length > 0 ? noDueDateItems.map(t => `- ${t}`).join("\n") : "- All items have due dates ✓"}

Out-of-Sequence Work (not on 90-day plan):
${outOfSequenceItems.length > 0 ? outOfSequenceItems.map(t => `- ${t}`).join("\n") : "- All work aligned with plan ✓"}

${userFirstName}'s Overrides Today:
${overridesToday.length > 0 ? overridesToday.map(o => `- ${o}`).join("\n") : "- No overrides today ✓"}

Pitch/Demo Feedback:
${demoFeedback.length > 0 ? demoFeedback.join("\n\n---\n\n") : "- No demos analyzed today"}`;

  const accountabilityPromptLegacy = `Generate ${accountabilityName}'s EOD brief for ${today}. ${accountabilityName} is ${userName}'s accountability partner for FlipIQ.

${accountabilityDataOnly}

Format ${accountabilityName}'s brief with:
1. ${userFirstName}'s activity summary
2. Items without due dates (action items for ${accountabilityName})
3. Out-of-sequence alerts
4. Overrides today
5. Demo feedback if available
6. Accountability score: ${completionRate}%
7. Dynamic action items for ${accountabilityName} tomorrow`;

  // Helper: same skill ("eod-report") with a recipient meta hint.
  // runtimePrompt = data-only (skill body has format/voice).
  // legacyPrompt = full prompt with instructions.
  async function generateEodFor(
    recipient: "tony" | "ethan",
    runtimePrompt: string,
    legacyPrompt: string,
  ): Promise<string> {
    if (isAgentRuntimeEnabled("brief")) {
      const result = await runAgent("brief", "eod-report", {
        userMessage: runtimePrompt,
        caller: "direct",
        meta: { recipient, date: today },
      });
      return result.text;
    }
    const msg = await createTrackedMessage("eod_report", {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: legacyPrompt }],
    });
    const block = msg.content.find(b => b.type === "text");
    return block?.type === "text" ? block.text : "";
  }

  let userReportText = "";
  try {
    userReportText = await generateEodFor("tony", userDataOnly, userPromptLegacy);
  } catch {
    userReportText = `EOD Report — ${today}\n\nCalls: ${callsMade} | Demos: ${demosBooked} | Tasks: ${tasksCompleted}\n\n${callList}`;
  }

  let accountabilityReportText = "";
  try {
    accountabilityReportText = await generateEodFor("ethan", accountabilityDataOnly, accountabilityPromptLegacy);
  } catch {
    accountabilityReportText = `${accountabilityName}'s EOD Brief — ${today}\n\nAccountability: ${completionRate}%\nNo-due-date items: ${noDueDateItems.length}\nOut-of-sequence: ${outOfSequenceItems.length}\nOverrides: ${overridesToday.length}`;
  }

  const userResult = await sendEmail({ to: userEmail, subject: `FlipIQ EOD — ${today}`, body: userReportText });
  const accountabilityResult = await sendEmail({ to: accountabilityEmail, subject: `${accountabilityName}'s EOD Brief — ${today}`, body: accountabilityReportText });

  const sentTo = [userResult.ok ? userEmail : "", accountabilityResult.ok ? accountabilityEmail : ""].filter(Boolean).join(",") || "failed";

  await personalDb
    .insert(eodReportsTable)
    .values({ date: today, callsMade, demosBooked, tasksCompleted, reportText: userReportText, sentTo })
    .onConflictDoUpdate({
      target: eodReportsTable.date,
      set: { callsMade, demosBooked, tasksCompleted, reportText: userReportText, sentTo },
    });

  return { ok: true, alreadySent: false, callsMade, demosBooked, tasksCompleted };
}

// Auto-EOD endpoint: called by frontend timer at 4:30 PM Pacific
// Guard: only sends once per day. Generates separate reports for Tony and Ethan.
router.post("/eod-report/auto", async (req, res): Promise<void> => {
  try {
    const result = await sendAutoEod();
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Auto-EOD failed");
    res.status(500).json({ ok: false, error: "Auto-EOD failed" });
  }
});

export default router;
