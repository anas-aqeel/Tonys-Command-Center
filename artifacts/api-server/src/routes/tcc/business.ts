import { Router, type IRouter } from "express";
import { sharedDb } from "@workspace/db";
import { eq, asc, desc, and } from "drizzle-orm";
import { companyGoalsTable, teamRolesTable, goalCompletionsTable, businessContextTable } from "../../lib/schema-v2";
import { getSheetValues, getSheetsClient } from "../../lib/google-sheets";

const router: IRouter = Router();

const BUSINESS_MASTER_SHEET_ID = process.env.BUSINESS_MASTER_SHEET_ID || "1WGuJwCoWbwyFamXXP79yxnPmYhdFPgOGhOR8_V-EQyw";

const HORIZON_ORDER = ["5yr", "1yr", "quarterly", "monthly", "weekly", "daily"];

// ─── Goals ───────────────────────────────────────────────────────────────────

router.get("/business/goals", async (req, res): Promise<void> => {
  try {
    const { horizon, owner, status } = req.query;
    const goals = await sharedDb.select().from(companyGoalsTable)
      .orderBy(asc(companyGoalsTable.position), asc(companyGoalsTable.createdAt));
    let filtered = goals;
    if (horizon) filtered = filtered.filter(g => g.horizon === horizon);
    if (owner) filtered = filtered.filter(g => g.owner?.toLowerCase() === String(owner).toLowerCase());
    if (status) filtered = filtered.filter(g => g.status === status);
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/business/goals/by-horizon", async (_req, res): Promise<void> => {
  try {
    const goals = await sharedDb.select().from(companyGoalsTable)
      .orderBy(asc(companyGoalsTable.position), asc(companyGoalsTable.createdAt));
    const grouped: Record<string, typeof goals> = {};
    for (const h of HORIZON_ORDER) grouped[h] = [];
    for (const g of goals) {
      const h = g.horizon || "other";
      if (!grouped[h]) grouped[h] = [];
      grouped[h].push(g);
    }
    res.json(grouped);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/business/goals/:horizon", async (req, res): Promise<void> => {
  try {
    const { horizon } = req.params;
    const goals = await sharedDb.select().from(companyGoalsTable)
      .where(eq(companyGoalsTable.horizon, horizon))
      .orderBy(asc(companyGoalsTable.position), asc(companyGoalsTable.createdAt));
    res.json(goals);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/business/goals", async (req, res): Promise<void> => {
  try {
    const { horizon, title, description, owner, status, dueDate } = req.body;
    if (!horizon || !title) { res.status(400).json({ error: "horizon and title required" }); return; }
    const [goal] = await sharedDb.insert(companyGoalsTable).values({
      horizon, title, description, owner: owner || (process.env.TCC_USER_NAME || "Tony").split(/\s+/)[0],
      status: status || "active", dueDate: dueDate || null,
    }).returning();
    push411ToSheet().catch(() => {});
    res.json(goal);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.patch("/business/goals/:id", async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const { title, description, owner, status, dueDate, position, horizon } = req.body;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (owner !== undefined) updates.owner = owner;
    if (status !== undefined) {
      updates.status = status;
      if (status === "done") updates.completedAt = new Date();
    }
    if (dueDate !== undefined) updates.dueDate = dueDate || null;
    if (position !== undefined) updates.position = position;
    if (horizon !== undefined) updates.horizon = horizon;

    const [goal] = await sharedDb.update(companyGoalsTable).set(updates).where(eq(companyGoalsTable.id, id)).returning();
    if (!goal) { res.status(404).json({ error: "Goal not found" }); return; }

    if (status === "done") {
      await sharedDb.insert(goalCompletionsTable).values({ goalId: id, goalTitle: goal.title, horizon: goal.horizon }).catch(() => {});
    }

    push411ToSheet().catch(() => {});

    res.json(goal);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete("/business/goals/:id", async (req, res): Promise<void> => {
  try {
    await sharedDb.delete(companyGoalsTable).where(eq(companyGoalsTable.id, req.params.id));
    push411ToSheet().catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/business/goals/reorder", async (req, res): Promise<void> => {
  try {
    const { orderedIds } = req.body as { orderedIds: string[] };
    if (!Array.isArray(orderedIds)) { res.status(400).json({ error: "orderedIds array required" }); return; }
    await Promise.all(orderedIds.map((id, pos) =>
      sharedDb.update(companyGoalsTable).set({ position: pos, updatedAt: new Date() }).where(eq(companyGoalsTable.id, id))
    ));
    push411ToSheet().catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Team ────────────────────────────────────────────────────────────────────

router.get("/business/team", async (_req, res): Promise<void> => {
  try {
    const team = await sharedDb.select().from(teamRolesTable).orderBy(asc(teamRolesTable.position), asc(teamRolesTable.name));
    res.json(team);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/business/team", async (req, res): Promise<void> => {
  try {
    const { name, slackId, email, role, responsibilities, currentFocus, metrics } = req.body;
    if (!name || !role) { res.status(400).json({ error: "name and role required" }); return; }
    const [member] = await sharedDb.insert(teamRolesTable).values({
      name, slackId, email, role,
      responsibilities: responsibilities || [],
      currentFocus, metrics: metrics || {},
    }).returning();
    res.json(member);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.patch("/business/team/:id", async (req, res): Promise<void> => {
  try {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const fields = ["name", "slackId", "email", "role", "responsibilities", "currentFocus", "metrics", "position"] as const;
    for (const f of fields) {
      if (req.body[f] !== undefined) updates[f === "slackId" ? "slackId" : f] = req.body[f];
    }
    const [member] = await sharedDb.update(teamRolesTable).set(updates).where(eq(teamRolesTable.id, req.params.id)).returning();
    if (!member) { res.status(404).json({ error: "Team member not found" }); return; }
    pushTeamToSheet().catch(() => {});
    res.json(member);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Seed default team members if none exist ─────────────────────────────────

router.post("/business/team/seed", async (_req, res): Promise<void> => {
  try {
    const defaults = [
      {
        name: process.env.TCC_USER_NAME || "Tony Diaz",
        slackId: process.env.TCC_USER_SLACK_ID || "U0991BAS0TC",
        email: process.env.TCC_USER_EMAIL || "tony@flipiq.com",
        role: process.env.TCC_USER_ROLE || "CEO",
        responsibilities: ["Sales strategy", "Acquisition associate oversight", "Key deal relationships", "Company vision"],
        currentFocus: "Closing 2 deals/month per AA, hitting $100K revenue", position: 0,
      },
      {
        name: "Ethan", slackId: "U0991BD321Y", email: "ethan@flipiq.com", role: "COO",
        responsibilities: ["Operations", "Team management", "Accountability reporting", "Process optimization"],
        currentFocus: "Keeping team on track with 90-day plan", position: 1,
      },
      {
        name: "Nate", slackId: "U0991BFNZ7U", email: "nate@flipiq.com", role: "Tech Lead",
        responsibilities: ["Platform development", "AI/tech features", "Infrastructure", "System reliability"],
        currentFocus: "Building COO Dashboard and AI tooling", position: 2,
      },
      {
        name: "Ramy", slackId: null, email: null, role: "Acquisition Associate",
        responsibilities: ["Sales calls", "Lead follow-up", "Demo scheduling", "Pipeline management"],
        currentFocus: "2 deals/month target", position: 3,
      },
    ];
    for (const m of defaults) {
      await sharedDb.insert(teamRolesTable).values(m).onConflictDoUpdate({
        target: teamRolesTable.name,
        set: { role: m.role, slackId: m.slackId, email: m.email, currentFocus: m.currentFocus, position: m.position, updatedAt: new Date() },
      });
    }
    res.json({ ok: true, seeded: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Business context (plans/docs) ───────────────────────────────────────────

router.get("/business/context", async (_req, res): Promise<void> => {
  try {
    const rows = await sharedDb.select().from(businessContextTable);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Goal completions history ─────────────────────────────────────────────────

router.get("/business/goal-completions", async (_req, res): Promise<void> => {
  try {
    const rows = await sharedDb.select().from(goalCompletionsTable).orderBy(desc(goalCompletionsTable.completedAt)).limit(100);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Sync 411 plan from Google Sheet ─────────────────────────────────────────

export async function push411ToSheet(): Promise<void> {
  if (!BUSINESS_MASTER_SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    const goals = await sharedDb.select().from(companyGoalsTable).orderBy(asc(companyGoalsTable.position));
    const header = ["Horizon", "Goal / ONE THING", "Owner", "Status", "Due Date", "Description"];
    const rows = goals.map(g => [
      g.horizon, g.title, g.owner || (process.env.TCC_USER_NAME || "Tony").split(/\s+/)[0], g.status || "active",
      g.dueDate || "", g.description || "",
    ]);
    await sheets.spreadsheets.values.clear({ spreadsheetId: BUSINESS_MASTER_SHEET_ID, range: "411 Plan!A:Z" });
    if (rows.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: BUSINESS_MASTER_SHEET_ID,
        range: "411 Plan!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [header, ...rows] },
      });
    }
    console.log(`[business] push411ToSheet: ${rows.length} goals pushed`);
  } catch (err) {
    console.warn("[business] push411ToSheet failed:", (err as Error).message);
  }
}

export async function pushTeamToSheet(): Promise<void> {
  if (!BUSINESS_MASTER_SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    const team = await sharedDb.select().from(teamRolesTable).orderBy(asc(teamRolesTable.position), asc(teamRolesTable.name));
    const header = ["Name", "Role / Title", "Email", "Current Focus / Priority", "Responsibilities"];
    const rows = team.map(m => [
      m.name, m.role, m.email || "", m.currentFocus || "",
      Array.isArray(m.responsibilities) ? (m.responsibilities as string[]).join(", ") : (m.responsibilities as string | null) || "",
    ]);
    await sheets.spreadsheets.values.clear({ spreadsheetId: BUSINESS_MASTER_SHEET_ID, range: "Team Roster!A:Z" });
    if (rows.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: BUSINESS_MASTER_SHEET_ID,
        range: "Team Roster!A1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [header, ...rows] },
      });
    }
    console.log(`[business] pushTeamToSheet: ${rows.length} members pushed`);
  } catch (err) {
    console.warn("[business] pushTeamToSheet failed:", (err as Error).message);
  }
}

router.post("/business/push-to-sheet", async (_req, res): Promise<void> => {
  try {
    await Promise.all([push411ToSheet(), pushTeamToSheet()]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
