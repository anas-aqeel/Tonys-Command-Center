import { Router, type IRouter } from "express";
import { personalDb, taskCompletionsTable, taskWorkNotesTable } from "@workspace/db";
import { MarkTaskCompleteBody } from "@workspace/api-zod";
import { eq, gte, and, desc } from "drizzle-orm";
import { getLinearIssues } from "../../lib/linear";
import { todayPacific } from "../../lib/dates.js";
import { localTasksTable } from "../../lib/schema-v2";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { z } from "zod/v4";
import { createGoogleTask, completeGoogleTask, listGoogleTasks } from "../../lib/gtasks.js";
import { recordFeedback } from "../../agents/feedback.js";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";

const router: IRouter = Router();

router.get("/tasks/completed", async (req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const completions = await personalDb
    .select()
    .from(taskCompletionsTable)
    .where(gte(taskCompletionsTable.completedAt, today));

  res.json(completions);
});

router.post("/tasks/completed", async (req, res): Promise<void> => {
  const parsed = MarkTaskCompleteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [completion] = await personalDb
    .insert(taskCompletionsTable)
    .values({
      taskId: parsed.data.taskId,
      taskText: parsed.data.taskText,
    })
    .returning();

  res.status(201).json(completion);
});

router.delete("/tasks/completed/:taskId", async (req, res): Promise<void> => {
  const { taskId } = req.params;
  if (!taskId) {
    res.status(400).json({ error: "taskId is required" });
    return;
  }

  await personalDb
    .delete(taskCompletionsTable)
    .where(eq(taskCompletionsTable.taskId, taskId));

  res.json({ ok: true, taskId });
});

// ── Work Notes ──────────────────────────────────────────────────────────────

router.post("/tasks/work-note", async (req, res): Promise<void> => {
  const { taskId, note, progress, nextSessionDate, nextSteps, driveFileId, driveFileName, driveLinkUrl } = req.body as {
    taskId?: string;
    note?: string;
    progress?: number;
    nextSessionDate?: string;
    nextSteps?: string;
    driveFileId?: string;
    driveFileName?: string;
    driveLinkUrl?: string;
  };

  if (!taskId || !note?.trim()) {
    res.status(400).json({ error: "taskId and note are required" });
    return;
  }

  // Require nextSessionDate when progress < 100
  const pct = progress ?? 0;
  if (pct < 100 && !nextSessionDate) {
    res.status(400).json({ error: "nextSessionDate is required when task is not 100% complete" });
    return;
  }

  const today = todayPacific();
  const [record] = await personalDb
    .insert(taskWorkNotesTable)
    .values({
      taskId,
      date: today,
      note: note.trim(),
      progress: pct,
      nextSessionDate: pct < 100 ? (nextSessionDate || null) : null,
      nextSteps: nextSteps?.trim() || null,
      driveFileId: driveFileId || null,
      driveFileName: driveFileName || null,
      driveLinkUrl: driveLinkUrl || null,
    })
    .returning();

  res.status(201).json(record);
});

router.get("/tasks/work-notes/:taskId", async (req, res): Promise<void> => {
  const { taskId } = req.params;
  if (!taskId) {
    res.status(400).json({ error: "taskId is required" });
    return;
  }

  const notes = await personalDb
    .select()
    .from(taskWorkNotesTable)
    .where(eq(taskWorkNotesTable.taskId, taskId))
    .orderBy(taskWorkNotesTable.createdAt);

  res.json(notes);
});

// Get all work notes logged today (for EOD)
router.get("/tasks/work-notes-today", async (req, res): Promise<void> => {
  const today = todayPacific();
  const notes = await personalDb
    .select()
    .from(taskWorkNotesTable)
    .where(eq(taskWorkNotesTable.date, today));

  res.json(notes);
});

// Pull active issues from Linear to surface as tasks in TCC checklist
router.get("/tasks/linear", async (req, res): Promise<void> => {
  try {
    const issues = await getLinearIssues();
    const tasks = issues.map(issue => ({
      id: `linear-${issue.id}`,
      text: `[${issue.identifier}] ${issue.title}`,
      cat: "TECH",
      state: issue.state?.name ?? "In Progress",
      priority: issue.priority,
      linearId: issue.id,
      linearIdentifier: issue.identifier,
      source: "linear" as const,
    }));
    res.json(tasks);
  } catch (err) {
    req.log.warn({ err }, "Linear tasks fetch failed");
    res.json([]);
  }
});

// Get all active local tasks
router.get("/tasks/local", async (req, res): Promise<void> => {
  const tasks = await personalDb
    .select()
    .from(localTasksTable)
    .where(eq(localTasksTable.status, "active"))
    .orderBy(localTasksTable.dueDate, localTasksTable.createdAt);
  res.json(tasks);
});

router.patch("/tasks/local/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  const { status } = req.body as { status?: string };

  const [updated] = await personalDb
    .update(localTasksTable)
    .set({ status: status || "done" })
    .where(eq(localTasksTable.id, id))
    .returning();

  // Sync completion to Google Tasks
  if ((status === "done" || !status) && updated?.googleTaskId) {
    completeGoogleTask(updated.googleTaskId).catch(err =>
      console.warn("[tasks] Google Task complete sync failed:", err)
    );
  }

  res.json({ ok: true });
});

const CreateTaskBody = z.object({
  text: z.string().min(1, "text is required"),
  dueDate: z.string().optional(),
  checkOnly: z.boolean().optional(),
  overrideWarning: z.string().optional(),
  taskType: z.enum(["one_time", "ongoing"]).optional(),
  size: z.enum(["XS", "S", "M", "L", "XL"]).optional(),
});

interface PriorityItem {
  id: string;
  text: string;
  source: "linear" | "local";
  priority?: number;
}

async function checkTaskPriority(
  taskText: string,
  linearIssues: PriorityItem[],
  localTasks: PriorityItem[]
): Promise<{ hasHigherPriority: boolean; count: number; items: PriorityItem[]; newTaskPriority: number }> {
  const allTasks = [...linearIssues.slice(0, 5), ...localTasks.slice(0, 5)];

  if (allTasks.length === 0) {
    return { hasHigherPriority: false, count: 0, items: [], newTaskPriority: 50 };
  }

  const taskList = allTasks.map((t, i) => `${i + 1}. [${t.source}] ${t.text}`).join("\n");

  const userMessage = `NEW TASK: "${taskText}"\n\nEXISTING ACTIVE TASKS:\n${taskList}`;

  let raw = "";

  // Flag-gated: AGENT_RUNTIME_TASKS=true routes through runtime.
  if (isAgentRuntimeEnabled("tasks")) {
    const result = await runAgent("tasks", "check-priority", {
      userMessage,
      caller: "direct",
      meta: { taskText, existingCount: allTasks.length },
    });
    raw = result.text.trim();
  } else {
    const msg = await createTrackedMessage("task_classify", {
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: `You are Tony Diaz's priority checker for FlipIQ. Tony's top priority is always: Sales calls first, then ops support, then everything else.

NEW TASK: "${taskText}"

EXISTING ACTIVE TASKS:
${taskList}

Which of the existing tasks are higher priority than the new task? A task is higher priority if it's more urgent or directly moves revenue.

Return ONLY valid JSON:
{
  "newTaskPriority": <number 1-100, lower = higher priority>,
  "higherPriorityItems": [<array of 1-based indices of existing tasks that are HIGHER priority than the new task>]
}

Return ONLY the JSON object, no markdown.`
      }]
    });
    const block = msg.content[0];
    if (block.type !== "text") return { hasHigherPriority: false, count: 0, items: [], newTaskPriority: 50 };
    raw = block.text.trim();
  }

  raw = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
  const parsed = JSON.parse(raw);

  const higherItems = (parsed.higherPriorityItems as number[] || [])
    .filter((i: number) => i >= 1 && i <= allTasks.length)
    .map((i: number) => allTasks[i - 1]);

  return {
    hasHigherPriority: higherItems.length > 0,
    count: higherItems.length,
    items: higherItems,
    newTaskPriority: parsed.newTaskPriority ?? 50,
  };
}

// Smart task creation with priority check
router.post("/tasks/create-with-check", async (req, res): Promise<void> => {
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { text, dueDate, checkOnly, overrideWarning, taskType, size } = parsed.data;

  // Fetch existing tasks for priority comparison
  let linearIssues: PriorityItem[] = [];
  let localTasks: PriorityItem[] = [];

  try {
    const issues = await getLinearIssues();
    linearIssues = issues.slice(0, 8).map(issue => ({
      id: `linear-${issue.id}`,
      text: `[${issue.identifier}] ${issue.title}`,
      source: "linear" as const,
      priority: issue.priority,
    }));
  } catch { /* ok — Linear may not be connected */ }

  try {
    const rows = await personalDb
      .select()
      .from(localTasksTable)
      .where(eq(localTasksTable.status, "active"))
      .orderBy(localTasksTable.priority, localTasksTable.createdAt)
      .limit(8);
    localTasks = rows.map(r => ({
      id: r.id,
      text: r.text,
      source: "local" as const,
      priority: r.priority ?? undefined,
    }));
  } catch { /* ok */ }

  // Run priority check via Claude
  let priorityCheck: { hasHigherPriority: boolean; count: number; items: PriorityItem[]; newTaskPriority: number };
  try {
    priorityCheck = await checkTaskPriority(text, linearIssues, localTasks);
  } catch (err) {
    req.log.warn({ err }, "Priority check failed — skipping");
    priorityCheck = { hasHigherPriority: false, count: 0, items: [], newTaskPriority: 50 };
  }

  // If checkOnly, return the assessment without saving
  if (checkOnly) {
    res.json({ ok: true, priorityCheck });
    return;
  }

  // Save the task to local DB first
  const [task] = await personalDb
    .insert(localTasksTable)
    .values({
      text,
      dueDate: dueDate ?? null,
      priority: priorityCheck.newTaskPriority,
      status: "active",
      overrideWarning: overrideWarning ?? null,
      taskType: taskType ?? "one_time",
      size: size ?? null,
    })
    .returning();

  // If user proceeded after a priority warning, log it as feedback so Coach
  // can learn what kind of warnings Tony overrides. Awaited so we can return
  // feedback_id to the FE for the Train-now toast deep-link.
  let feedbackId: string | undefined;
  if (overrideWarning) {
    try {
      const fb = await recordFeedback({
        agent: "tasks",
        skill: "check-priority",
        sourceType: "override",
        sourceId: task.id,
        reviewText: overrideWarning,
        snapshotExtra: { taskText: text, dueDate, priorityCheck },
      });
      feedbackId = fb.feedbackId;
    } catch (err) { console.error("[tasks] recordFeedback failed:", err); }
  }

  // Create matching Google Task (fire-and-forget, update googleTaskId when done)
  createGoogleTask(text, dueDate ?? null).then(async googleTaskId => {
    if (googleTaskId) {
      await personalDb
        .update(localTasksTable)
        .set({ googleTaskId })
        .where(eq(localTasksTable.id, task.id));
    }
  }).catch(err => console.warn("[tasks] Google Task create sync failed:", err));

  res.status(201).json({ ...task, feedback_id: feedbackId });
});

async function syncGoogleCompletions(): Promise<number> {
  const localTasks = await personalDb
    .select()
    .from(localTasksTable)
    .where(eq(localTasksTable.status, "active"));

  const linked = localTasks.filter(t => t.googleTaskId);
  if (linked.length === 0) return 0;

  const { google } = await import("googleapis");
  const { getGoogleAuth } = await import("../../lib/google-auth.js");
  const gtasks = google.tasks({ version: "v1", auth: getGoogleAuth() });
  const gRes = await gtasks.tasks.list({
    tasklist: "@default",
    showCompleted: true,
    showHidden: true,
    maxResults: 200,
  });

  const completedIds = new Set(
    (gRes.data.items || [])
      .filter(t => t.status === "completed" && t.id)
      .map(t => t.id!)
  );

  let synced = 0;
  for (const local of linked) {
    if (local.googleTaskId && completedIds.has(local.googleTaskId)) {
      await personalDb
        .update(localTasksTable)
        .set({ status: "done" })
        .where(eq(localTasksTable.id, local.id));
      synced++;
    }
  }
  return synced;
}

// Sync Google Tasks → TCC: mark any Google-completed tasks as done locally
router.post("/tasks/sync-google", async (req, res): Promise<void> => {
  try {
    const synced = await syncGoogleCompletions();
    res.json({ ok: true, synced });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Refresh: sync from Google Tasks then return updated active task list
router.get("/tasks/refresh", async (req, res): Promise<void> => {
  try {
    await syncGoogleCompletions();
  } catch (err) {
    console.warn("[tasks/refresh] Google sync step failed:", err instanceof Error ? err.message : err);
  }

  const tasks = await personalDb
    .select()
    .from(localTasksTable)
    .where(eq(localTasksTable.status, "active"))
    .orderBy(localTasksTable.priority, localTasksTable.createdAt);

  res.json(tasks);
});

// ── Task Alerts: out-of-sequence and missing due dates ──────────────────────
router.get("/tasks/alerts", async (req, res): Promise<void> => {
  try {
    const issues = await getLinearIssues();

    // (a) In-progress items where a higher-priority item is blocked/stalled
    const inProgress = issues.filter(i => {
      const stateName = (i.state?.name || "").toLowerCase();
      return stateName.includes("progress") || stateName.includes("started") || stateName.includes("doing");
    });

    const blocked = issues.filter(i => {
      const stateName = (i.state?.name || "").toLowerCase();
      return stateName.includes("blocked") || stateName.includes("waiting") || stateName.includes("todo");
    });

    // Find cases where a blocked item has higher priority (lower number = higher) than an in-progress item
    const outOfSequence: { id: string; identifier: string; title: string; state: string; priority: number }[] = [];
    for (const prog of inProgress) {
      const higherBlockers = blocked.filter(b => (b.priority || 99) < (prog.priority || 99));
      for (const blocker of higherBlockers) {
        outOfSequence.push({
          id: blocker.id,
          identifier: blocker.identifier,
          title: blocker.title,
          state: blocker.state?.name || "Blocked",
          priority: blocker.priority || 0,
        });
      }
    }

    // Deduplicate
    const seenIds = new Set<string>();
    const dedupedOutOfSeq = outOfSequence.filter(item => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    });

    // (b) Linear items missing due dates
    const missingDueDates = issues
      .filter(i => {
        const stateName = (i.state?.name || "").toLowerCase();
        const isActive = !stateName.includes("done") && !stateName.includes("cancelled") && !stateName.includes("completed");
        return isActive && !i.dueDate;
      })
      .map(i => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        state: i.state?.name || "Active",
        priority: i.priority || 0,
      }));

    res.json({
      outOfSequence: dedupedOutOfSeq,
      missingDueDates,
    });
  } catch (err) {
    req.log.warn({ err }, "tasks/alerts failed");
    res.json({ outOfSequence: [], missingDueDates: [] });
  }
});

export default router;
