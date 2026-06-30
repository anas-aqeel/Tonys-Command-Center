import { Router, type IRouter } from "express";
import { sharedDb, meetingHistoryTable } from "@workspace/db";
import { eq, desc, ilike } from "drizzle-orm";
import { createTrackedMessage } from "@workspace/integrations-anthropic-ai";

const router: IRouter = Router();

router.get("/meeting-history", async (req, res): Promise<void> => {
  const { contactName, limit = "20" } = req.query as Record<string, string>;
  const lim = Math.min(parseInt(limit) || 20, 100);

  let rows;
  if (contactName && contactName.trim()) {
    rows = await sharedDb
      .select()
      .from(meetingHistoryTable)
      .where(ilike(meetingHistoryTable.contactName, `%${contactName.trim()}%`))
      .orderBy(desc(meetingHistoryTable.date))
      .limit(lim);
  } else {
    rows = await sharedDb
      .select()
      .from(meetingHistoryTable)
      .orderBy(desc(meetingHistoryTable.date))
      .limit(lim);
  }

  res.json(rows);
});

router.post("/meeting-history", async (req, res): Promise<void> => {
  const { date, contactName, summary, nextSteps, outcome } = req.body as Record<string, string>;
  if (!date) { res.status(400).json({ error: "date is required" }); return; }

  const [row] = await sharedDb
    .insert(meetingHistoryTable)
    .values({ date, contactName: contactName ?? null, summary: summary ?? null, nextSteps: nextSteps ?? null, outcome: outcome ?? null })
    .returning();

  res.status(201).json(row);
});

router.delete("/meeting-history/:id", async (req, res): Promise<void> => {
  await sharedDb.delete(meetingHistoryTable).where(eq(meetingHistoryTable.id, req.params.id));
  res.json({ ok: true });
});

// Paste a meeting transcript → AI extracts key fields → save to meeting_history.
router.post("/meeting-history/extract", async (req, res): Promise<void> => {
  const { transcript, contactName, date } = req.body as { transcript?: string; contactName?: string; date?: string };
  if (!transcript || !transcript.trim()) {
    res.status(400).json({ error: "transcript is required" });
    return;
  }

  const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const meetingDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayISO;

  const userPrompt = `Extract key details from this meeting transcript.

Contact: ${contactName || "(unknown)"}
Transcript:
${transcript.slice(0, 12000)}

Return ONLY a JSON object with these fields (no markdown, no fences):
{
  "summary": "2-3 sentence summary of what was discussed",
  "nextSteps": "Bullet list of action items (one per line, prefixed with • ). Empty string if none.",
  "outcome": "1 sentence describing the meeting outcome or decision"
}`;

  let summary = "";
  let nextSteps = "";
  let outcome = "";

  try {
    const message = await createTrackedMessage("meeting_history_extract", {
      model: "claude-haiku-4-5",
      max_tokens: 800,
      messages: [{ role: "user", content: userPrompt }],
    });
    const block = message.content[0];
    const raw = block && block.type === "text" ? block.text : "";

    let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    if (!cleaned.startsWith("{")) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) cleaned = m[0];
    }
    const parsed = JSON.parse(cleaned);
    summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    nextSteps = typeof parsed.nextSteps === "string" ? parsed.nextSteps.trim() : "";
    outcome = typeof parsed.outcome === "string" ? parsed.outcome.trim() : "";
  } catch (err) {
    req.log.warn({ err }, "[meeting-history/extract] AI parse failed — saving with raw transcript snippet");
    summary = transcript.slice(0, 280) + (transcript.length > 280 ? "…" : "");
  }

  const [row] = await sharedDb
    .insert(meetingHistoryTable)
    .values({
      date: meetingDate,
      contactName: contactName ?? null,
      summary: summary || null,
      nextSteps: nextSteps || null,
      outcome: outcome || null,
    })
    .returning();

  res.status(201).json(row);
});

export default router;
