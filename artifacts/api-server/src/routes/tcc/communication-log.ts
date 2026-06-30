import { Router, type IRouter } from "express";
import { sharedDb } from "@workspace/db";
import { communicationLogTable } from "../../lib/schema-v2";
import { eq, desc, gte, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/communication-log/recent", async (req, res): Promise<void> => {
  const hours = Number(req.query.hours) || 48;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const logs = await sharedDb.select()
    .from(communicationLogTable)
    .where(gte(communicationLogTable.loggedAt, since))
    .orderBy(desc(communicationLogTable.loggedAt))
    .limit(100);

  res.json(logs);
});

router.get("/communication-log/:contactId/stats", async (req, res): Promise<void> => {
  const { contactId } = req.params;

  const stats = await sharedDb.select({
    channel: communicationLogTable.channel,
    count: sql<number>`COUNT(*)`,
    lastDate: sql<string>`MAX(logged_at)`,
  })
    .from(communicationLogTable)
    .where(eq(communicationLogTable.contactId, contactId))
    .groupBy(communicationLogTable.channel);

  const total = stats.reduce((sum, s) => sum + Number(s.count), 0);
  const lastComm = stats.reduce((latest, s) =>
    !latest || new Date(s.lastDate) > new Date(latest) ? s.lastDate : latest,
    "" as string
  );

  const daysSince = lastComm
    ? Math.floor((Date.now() - new Date(lastComm).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  res.json({
    stats: Object.fromEntries(stats.map(s => [s.channel, { count: Number(s.count), lastDate: s.lastDate }])),
    totalInteractions: total,
    lastCommunication: lastComm || null,
    daysSinceContact: daysSince,
  });
});

router.get("/communication-log/:contactId", async (req, res): Promise<void> => {
  const { contactId } = req.params;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;

  const logs = await sharedDb.select()
    .from(communicationLogTable)
    .where(eq(communicationLogTable.contactId, contactId))
    .orderBy(desc(communicationLogTable.loggedAt))
    .limit(limit)
    .offset(offset);

  const [countResult] = await sharedDb.select({ count: sql<number>`COUNT(*)` })
    .from(communicationLogTable)
    .where(eq(communicationLogTable.contactId, contactId));

  res.json({ logs, total: countResult?.count || 0 });
});

export default router;
