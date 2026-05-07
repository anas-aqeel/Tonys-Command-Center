import { Router } from "express";
import { logger } from "../../lib/logger";

const router = Router();

// Verify cron requests are from Vercel (or authorized)
function verifyCron(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  const cronSecret = process.env.CRON_SECRET;
  // If CRON_SECRET is not set, allow all (local dev)
  if (!cronSecret) return next();

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Every 5 minutes — Google Sheets sync
router.post("/cron/sheets-sync", verifyCron, async (_req, res) => {
  try {
    const { startAutoSync } = await import("./sheets-sync");
    // startAutoSync sets up an interval — for cron, we just call the sync once
    // We need the actual sync function, not the interval starter
    const { syncContextIngest } = await import("./sheets-sync");
    await syncContextIngest();
    res.json({ ok: true, task: "sheets-sync" });
  } catch (err) {
    logger.error({ err }, "Cron sheets-sync failed");
    res.status(500).json({ error: "sheets-sync failed" });
  }
});

// Daily at ~4:30 PM Pacific — EOD report
router.post("/cron/eod", verifyCron, async (_req, res) => {
  try {
    const { sendAutoEod } = await import("./eod");
    const result = await sendAutoEod();
    res.json({ task: "eod", ...result, ok: true });
  } catch (err) {
    logger.error({ err }, "Cron EOD failed");
    res.status(500).json({ error: "eod failed" });
  }
});

// Daily at 4 AM Pacific — business plan ingest + piggyback email reclassify.
// On Vercel Hobby tier we can't run /cron/email-reclassify on its own 6h
// schedule (Hobby caps at 2 crons total, daily-only), so the once-a-day
// email reclassify runs here. Plan-ingest is awaited first so its success
// status is the response; email reclassify runs after with its own try/catch
// so an email failure can't mask a successful plan ingest.
router.post("/cron/plan-ingest", verifyCron, async (_req, res) => {
  try {
    const { syncContextIngest } = await import("./sheets-sync");
    await syncContextIngest();

    let emailReclassify: { ok: boolean; result?: unknown; error?: string } = { ok: false };
    try {
      const { reclassifyRecentEmails } = await import("./brief");
      const r = await reclassifyRecentEmails({ hoursBack: 24 });
      emailReclassify = { ok: true, result: r };
    } catch (err) {
      logger.warn({ err }, "Piggyback email-reclassify failed (plan-ingest succeeded)");
      emailReclassify = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    res.json({ ok: true, task: "plan-ingest", emailReclassify });
  } catch (err) {
    logger.error({ err }, "Cron plan-ingest failed");
    res.status(500).json({ error: "plan-ingest failed" });
  }
});

// Every 6 hours — auto-reclassify emails from the past 24h.
// Reuses the same triage skill path as POST /brief/emails/reclassify (the
// agent_email_triage runtime), so each run logs to ai_usage_logs the same
// way live-time classification does.
router.post("/cron/email-reclassify", verifyCron, async (_req, res) => {
  try {
    const { reclassifyRecentEmails } = await import("./brief");
    const result = await reclassifyRecentEmails({ hoursBack: 24 });
    res.json({ task: "email-reclassify", ...result });
  } catch (err) {
    logger.error({ err }, "Cron email-reclassify failed");
    res.status(500).json({ error: "email-reclassify failed" });
  }
});

// Hourly 9 AM-6 PM Pacific — demo feedback scanner
router.post("/cron/demo-feedback", verifyCron, async (_req, res) => {
  try {
    const { analyzeDemoRecording } = await import("../../lib/demo-feedback");
    const { listTodayEvents } = await import("../../lib/gcal");
    const allEvents = await listTodayEvents();
    const demoEvents = (allEvents || []).filter(
      (e: { summary?: string }) => /demo|pitch|presentation/i.test(e.summary || "")
    );
    for (const evt of demoEvents.slice(0, 3)) {
      if (!evt.summary || !evt.start) continue;
      const eventDate = new Date(evt.start).toLocaleDateString("en-CA");
      await analyzeDemoRecording(evt.summary, eventDate).catch(() => null);
    }
    res.json({ ok: true, task: "demo-feedback", processed: demoEvents.length });
  } catch (err) {
    logger.error({ err }, "Cron demo-feedback failed");
    res.status(500).json({ error: "demo-feedback failed" });
  }
});

export default router;
