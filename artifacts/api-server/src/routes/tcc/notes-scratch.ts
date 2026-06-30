import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { personalDb, scratchNotesTable } from "@workspace/db";
import { z } from "zod/v4";

const router: IRouter = Router();

router.get("/notes/scratch", async (req, res): Promise<void> => {
  const notes = await personalDb
    .select()
    .from(scratchNotesTable)
    .orderBy(asc(scratchNotesTable.position), asc(scratchNotesTable.createdAt));
  res.json(notes);
});

const CreateNoteBody = z.object({
  text: z.string().min(1, "text is required"),
});

router.post("/notes/scratch", async (req, res): Promise<void> => {
  const parsed = CreateNoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const existing = await personalDb
    .select({ position: scratchNotesTable.position })
    .from(scratchNotesTable)
    .orderBy(asc(scratchNotesTable.position));

  const maxPos = existing.length > 0 ? existing[existing.length - 1].position + 1 : 0;

  const [note] = await personalDb
    .insert(scratchNotesTable)
    .values({ text: parsed.data.text, checked: false, position: maxPos })
    .returning();

  res.status(201).json(note);
});

const PatchNoteBody = z.object({
  checked: z.boolean().optional(),
  text: z.string().min(1).optional(),
});

router.patch("/notes/scratch/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  const parsed = PatchNoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<{ checked: boolean; text: string; updatedAt: Date }> = {
    updatedAt: new Date(),
  };
  if (parsed.data.checked !== undefined) updates.checked = parsed.data.checked;
  if (parsed.data.text !== undefined) updates.text = parsed.data.text;

  const [note] = await personalDb
    .update(scratchNotesTable)
    .set(updates)
    .where(eq(scratchNotesTable.id, id))
    .returning();

  if (!note) {
    res.status(404).json({ error: "Note not found" });
    return;
  }

  res.json(note);
});

router.delete("/notes/scratch/:id", async (req, res): Promise<void> => {
  const { id } = req.params;

  await personalDb.delete(scratchNotesTable).where(eq(scratchNotesTable.id, id));

  res.json({ ok: true });
});

export default router;
