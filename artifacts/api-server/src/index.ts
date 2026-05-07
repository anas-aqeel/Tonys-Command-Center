import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");

  // Schedulers only run in local dev — on Vercel they're triggered via cron endpoints
  if (process.env.VERCEL !== "1") {
    // Start Business Master Sheet auto-sync (every 5 minutes)
    import("./routes/tcc/sheets-sync").then(({ startAutoSync }) => {
      startAutoSync();
    }).catch(err => logger.warn({ err }, "Failed to start sheets auto-sync"));

    // Start server-side EOD scheduler (checks every 60s if it's past 4:30 PM Pacific)
    startEodScheduler();

    // Start business plan ingest scheduler (runs daily at 4 AM Pacific)
    startBusinessPlanIngest();

    // Start demo feedback scanner (runs hourly between 9 AM – 6 PM Pacific)
    startDemoFeedbackScanner();

    // Start email auto-reclassify (runs every 6 hours, reclassifies last 24h)
    startEmailReclassifyScheduler();
  }
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

function startEodScheduler(): void {
  logger.info("EOD scheduler started — checks every 60s for 4:30 PM Pacific trigger");
  let lastEodDate = "";

  setInterval(async () => {
    try {
      const nowPacific = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
      const pacific = new Date(nowPacific);
      const hour = pacific.getHours();
      const minute = pacific.getMinutes();
      const totalMinutes = hour * 60 + minute;
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

      // Trigger once per day at/after 4:30 PM Pacific — in-memory guard prevents repeated calls
      if (totalMinutes >= 16 * 60 + 30 && lastEodDate !== today) {
        const { sendAutoEod } = await import("./routes/tcc/eod");
        const result = await sendAutoEod();
        if (result.ok || result.alreadySent) {
          lastEodDate = today;
          if (!result.alreadySent) {
            logger.info({ today, callsMade: result.callsMade, demosBooked: result.demosBooked }, "EOD scheduler: EOD report sent");
          }
        } else {
          logger.warn({ today }, "EOD scheduler: EOD report failed — will retry next check");
        }
      }
    } catch (err) {
      logger.warn({ err }, "EOD scheduler: error during check");
    }
  }, 60 * 1000);
}

// ── Business Plan ingest — runs daily at 4 AM Pacific ────────────────────────
function startBusinessPlanIngest(): void {
  let lastIngestDate = "";
  logger.info("Business plan ingest scheduler started — checks every 5m for 4 AM Pacific trigger");
  setInterval(async () => {
    try {
      const nowPacific = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
      const pacific = new Date(nowPacific);
      const hour = pacific.getHours();
      const minute = pacific.getMinutes();
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      // Trigger between 4:00 and 4:30 AM Pacific, once per day
      if (hour === 4 && minute < 30 && today !== lastIngestDate) {
        lastIngestDate = today;
        const { syncContextIngest } = await import("./routes/tcc/sheets-sync.js");
        await syncContextIngest();
        logger.info({ today }, "Business plan ingest: completed");
      }
    } catch (err) {
      logger.warn({ err }, "Business plan ingest scheduler: error during check");
    }
  }, 5 * 60 * 1000); // check every 5 minutes
}

// ── Email auto-reclassify — runs every 6 hours ───────────────────────────────
// Reclassifies the last 24h of emails on a 6h cadence so the inbox triage
// stays current even when Tony isn't actively clicking "Reclassify". Reuses
// the same agent_email_triage runtime path the live UI uses, so each run
// logs to ai_usage_logs the same way.
function startEmailReclassifyScheduler(): void {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  logger.info("Email reclassify scheduler started — runs every 6 hours");

  const tick = async () => {
    try {
      const { reclassifyRecentEmails } = await import("./routes/tcc/brief");
      const result = await reclassifyRecentEmails({ hoursBack: 24 });
      if (result.ok) {
        logger.info({ classified: result.classified }, "Email reclassify scheduler: completed");
      } else {
        logger.warn({ error: result.error }, "Email reclassify scheduler: failed");
      }
    } catch (err) {
      logger.warn({ err }, "Email reclassify scheduler: error during run");
    }
  };

  // Fire once shortly after boot (give the server 60s to stabilize), then every 6h.
  setTimeout(tick, 60 * 1000);
  setInterval(tick, SIX_HOURS_MS);
}

// ── Demo feedback scanner — runs hourly between 9 AM – 6 PM Pacific ──────────
function startDemoFeedbackScanner(): void {
  let lastScanHour = -1;
  logger.info("Demo feedback scanner started — runs hourly 9 AM–6 PM Pacific");
  setInterval(async () => {
    try {
      const nowPacific = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
      const pacific = new Date(nowPacific);
      const hour = pacific.getHours();
      // Scan once per hour, between 9 AM and 6 PM
      if (hour >= 9 && hour < 18 && hour !== lastScanHour) {
        lastScanHour = hour;
        const { analyzeDemoRecording } = await import("./lib/demo-feedback.js");
        // Pull today's events from calendar and analyze demo recordings
        const { listTodayEvents } = await import("./lib/gcal.js");
        const allEvents = await listTodayEvents();
        const demoEvents = (allEvents || []).filter((e: { summary?: string }) =>
          /demo|pitch|presentation/i.test(e.summary || "")
        );
        for (const evt of demoEvents.slice(0, 3)) {
          if (!evt.summary || !evt.start) continue;
          const eventDate = new Date(evt.start).toLocaleDateString("en-CA");
          await analyzeDemoRecording(evt.summary, eventDate).catch(() => null);
        }
        if (demoEvents.length > 0) {
          logger.info({ count: demoEvents.length, hour }, "Demo feedback scanner: processed demos");
        }
      }
    } catch (err) {
      logger.warn({ err }, "Demo feedback scanner: error during check");
    }
  }, 10 * 60 * 1000); // check every 10 minutes, runs at most once per hour
}
