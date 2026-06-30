import { Router, type IRouter } from "express";
import { sharedDb, demosTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { todayPacific } from "../../lib/dates.js";

const router: IRouter = Router();

async function getTodayDemoCount(): Promise<number> {
  const today = todayPacific();
  const demos = await sharedDb
    .select()
    .from(demosTable)
    .where(eq(demosTable.scheduledDate, today));
  return demos.length;
}

router.get("/demos/count", async (req, res): Promise<void> => {
  const today = todayPacific();
  const count = await getTodayDemoCount();
  res.json({ count, date: today });
});

router.post("/demos/increment", async (req, res): Promise<void> => {
  const today = todayPacific();
  await sharedDb.insert(demosTable).values({
    scheduledDate: today,
    status: "scheduled",
  });
  const count = await getTodayDemoCount();
  res.json({ count, date: today });
});

router.post("/demos/decrement", async (req, res): Promise<void> => {
  const today = todayPacific();
  const [demo] = await sharedDb
    .select()
    .from(demosTable)
    .where(eq(demosTable.scheduledDate, today));
  
  if (demo) {
    await sharedDb.delete(demosTable).where(eq(demosTable.id, demo.id));
  }

  const count = await getTodayDemoCount();
  res.json({ count: Math.max(0, count), date: today });
});

export default router;
