import { Router, type IRouter } from "express";
import { personalDb, systemInstructionsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/system-instructions", async (req, res): Promise<void> => {
  const rows = await personalDb.select().from(systemInstructionsTable);
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.section] = row.content;
  }
  res.json(result);
});

router.post("/system-instructions", async (req, res): Promise<void> => {
  const { key, text } = req.body as { key?: string; text?: string };
  if (!key || typeof text !== "string") {
    res.status(400).json({ error: "key and text are required" });
    return;
  }

  // Use ON CONFLICT DO UPDATE to avoid select-then-insert race condition
  await personalDb
    .insert(systemInstructionsTable)
    .values({ section: key, content: text })
    .onConflictDoUpdate({
      target: systemInstructionsTable.section,
      set: { content: text, updatedAt: new Date() },
    });

  res.json({ ok: true, key, text });
});

export default router;
