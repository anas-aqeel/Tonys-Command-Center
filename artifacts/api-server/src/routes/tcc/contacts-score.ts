import { Router, type IRouter } from "express";
import { z } from "zod";
import { sharedDb, contactsTable } from "@workspace/db";
import { contactIntelligenceTable, communicationLogTable } from "../../lib/schema-v2";
import { eq, desc, sql, and, gte } from "drizzle-orm";

const router: IRouter = Router();

const ScoreBody = z.object({
  contactIds: z.array(z.string().uuid()),
});

router.post("/contacts/score", async (req, res): Promise<void> => {
  const parsed = ScoreBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const results: { contactId: string; score: number; reason: string }[] = [];

  for (const contactId of parsed.data.contactIds) {
    try {
      const [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
      if (!contact) { results.push({ contactId, score: 0, reason: "Contact not found" }); continue; }

      const [intel] = await sharedDb.select().from(contactIntelligenceTable)
        .where(eq(contactIntelligenceTable.contactId, contactId)).limit(1);

      const commStats = await sharedDb.select({
        channel: communicationLogTable.channel,
        count: sql<number>`COUNT(*)`,
        lastDate: sql<string>`MAX(logged_at)`,
      })
        .from(communicationLogTable)
        .where(eq(communicationLogTable.contactId, contactId))
        .groupBy(communicationLogTable.channel);

      const totalComms = commStats.reduce((s, c) => s + Number(c.count), 0);
      const lastCommDate = commStats.reduce((latest, c) =>
        !latest || new Date(c.lastDate) > new Date(latest) ? c.lastDate : latest, "" as string);

      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const recentComms = await sharedDb.select({ count: sql<number>`COUNT(*)` })
        .from(communicationLogTable)
        .where(and(eq(communicationLogTable.contactId, contactId), gte(communicationLogTable.loggedAt, weekAgo)));
      const recentCount = Number(recentComms[0]?.count || 0);

      let score = 0;
      const reasons: string[] = [];

      const contactType = (contact.type || "").toLowerCase();
      if (contactType.includes("broker") && contactType.includes("investor")) {
        score += 25; reasons.push("Broker-Investor type (+25) -- directly aligned to North Star");
      } else if (contactType.includes("broker")) {
        score += 20; reasons.push("Broker type (+20) -- key relationship for deal flow");
      } else if (contactType.includes("investor")) {
        score += 18; reasons.push("Investor type (+18) -- potential deal partner");
      } else if (contactType.includes("agent")) {
        score += 12; reasons.push("Agent type (+12)");
      } else if (contactType.includes("wholesaler")) {
        score += 10; reasons.push("Wholesaler type (+10)");
      } else {
        score += 5; reasons.push("Other type (+5)");
      }

      if (totalComms >= 10) { score += 20; reasons.push(`High engagement: ${totalComms} comms (+20)`); }
      else if (totalComms >= 5) { score += 15; reasons.push(`Good engagement: ${totalComms} comms (+15)`); }
      else if (totalComms >= 2) { score += 10; reasons.push(`Some engagement: ${totalComms} comms (+10)`); }
      else if (totalComms >= 1) { score += 5; reasons.push(`Initial contact: ${totalComms} comm (+5)`); }
      else { reasons.push("No communications yet (+0)"); }

      if (lastCommDate) {
        const daysSince = (Date.now() - new Date(lastCommDate).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince <= 1) { score += 20; reasons.push("Communicated today (+20)"); }
        else if (daysSince <= 3) { score += 16; reasons.push("Communicated in last 3 days (+16)"); }
        else if (daysSince <= 7) { score += 12; reasons.push("Communicated this week (+12)"); }
        else if (daysSince <= 14) { score += 8; reasons.push("Communicated in last 2 weeks (+8)"); }
        else if (daysSince <= 30) { score += 4; reasons.push("Communicated last month (+4)"); }
        else { reasons.push("Last comm over 30 days ago (+0)"); }
      } else {
        reasons.push("Never communicated (+0)");
      }

      const status = (contact.status || "").toLowerCase();
      if (status === "hot") { score += 15; reasons.push("Hot status (+15) -- active deal signal"); }
      else if (status === "warm") { score += 10; reasons.push("Warm status (+10)"); }
      else if (status === "new") { score += 5; reasons.push("New status (+5)"); }
      else { reasons.push("Cold/unknown status (+0)"); }

      const stage = intel?.stage || "new";
      const stagePoints: Record<string, number> = {
        new: 2, outreach: 4, engaged: 7, meeting_scheduled: 9, negotiating: 10,
        closed: 0, dormant: 0,
      };
      const stageScore = stagePoints[stage] || 2;
      score += stageScore;
      reasons.push(`Stage "${stage}" (+${stageScore})`);

      if (recentCount >= 3) { score += 10; reasons.push(`Very responsive: ${recentCount} this week (+10)`); }
      else if (recentCount >= 1) { score += 6; reasons.push(`Active: ${recentCount} this week (+6)`); }
      else { reasons.push("No recent activity (+0)"); }

      score = Math.min(score, 100);

      const [existing] = await sharedDb.select({ id: contactIntelligenceTable.id })
        .from(contactIntelligenceTable)
        .where(eq(contactIntelligenceTable.contactId, contactId)).limit(1);

      if (existing) {
        await sharedDb.update(contactIntelligenceTable).set({
          aiScore: String(score),
          aiScoreReason: reasons.join("\n"),
          lastAiScan: new Date(),
          updatedAt: new Date(),
        }).where(eq(contactIntelligenceTable.contactId, contactId));
      } else {
        await sharedDb.insert(contactIntelligenceTable).values({
          contactId,
          aiScore: String(score),
          aiScoreReason: reasons.join("\n"),
          lastAiScan: new Date(),
        });
      }

      results.push({ contactId, score, reason: reasons.join("; ") });
    } catch (err) {
      results.push({ contactId, score: 0, reason: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  res.json({ results });
});

export default router;
