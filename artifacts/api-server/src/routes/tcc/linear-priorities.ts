import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { sharedDb } from "@workspace/db";
import { linearPrioritiesTable } from "../../lib/schema-v2";
import { z } from "zod/v4";

const router: IRouter = Router();

const ALLOWED_ACTIONS = ["DO NOW", "KEEP", "PROMOTE", "PAUSE", "DEFER", "KILL"] as const;

router.get("/linear-priorities", async (_req, res): Promise<void> => {
  const rows = await sharedDb
    .select()
    .from(linearPrioritiesTable)
    .orderBy(asc(linearPrioritiesTable.priorityOrder));
  res.json(rows);
});

const CreateBody = z.object({
  linearRef: z.string().min(1),
  title: z.string().min(1),
  status: z.string().default(""),
  priority: z.string().default(""),
  owner: z.string().nullable().optional(),
  team: z.string().nullable().optional(),
  q2PlanRef: z.string().nullable().optional(),
  action: z.string().min(1),
  why: z.string().default(""),
  nextStep: z.string().nullable().optional(),
});

router.post("/linear-priorities", async (req, res): Promise<void> => {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = await sharedDb
    .select({ p: linearPrioritiesTable.priorityOrder })
    .from(linearPrioritiesTable)
    .orderBy(asc(linearPrioritiesTable.priorityOrder));
  const nextOrder = existing.length ? existing[existing.length - 1].p + 1 : 0;
  const isProject = parsed.data.linearRef.startsWith("Project:");
  const action = parsed.data.action.trim().toUpperCase();
  const [row] = await sharedDb
    .insert(linearPrioritiesTable)
    .values({ ...parsed.data, action, isProject, priorityOrder: nextOrder })
    .returning();
  res.status(201).json(row);
});

const PatchBody = z.object({
  linearRef: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  owner: z.string().nullable().optional(),
  team: z.string().nullable().optional(),
  q2PlanRef: z.string().nullable().optional(),
  action: z.string().min(1).optional(),
  why: z.string().optional(),
  nextStep: z.string().nullable().optional(),
  priorityOrder: z.number().int().optional(),
});

router.patch("/linear-priorities/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    updates[k] = v;
  }
  if (typeof updates.linearRef === "string") {
    updates.isProject = (updates.linearRef as string).startsWith("Project:");
  }
  if (typeof updates.action === "string") {
    updates.action = (updates.action as string).trim().toUpperCase();
  }
  const [row] = await sharedDb
    .update(linearPrioritiesTable)
    .set(updates)
    .where(eq(linearPrioritiesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.delete("/linear-priorities/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  await sharedDb.delete(linearPrioritiesTable).where(eq(linearPrioritiesTable.id, id));
  res.json({ ok: true });
});

router.get("/linear-priorities/_meta", (_req, res): void => {
  res.json({ allowedActions: ALLOWED_ACTIONS });
});

export default router;
