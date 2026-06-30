// schedule_meeting — orchestrator wrapper. Creates a sales-meeting calendar event.
// Preserves scope gatekeeper + morning protection logic from claude.ts verbatim.

import type { ToolHandler } from "../index.js";
import { createEvent } from "../../../lib/gcal.js";

const handler: ToolHandler = async (input) => {
  const contactName = String(input.contactName || "");
  const purpose = String(input.purpose || "sales").toLowerCase();
  const preferredDate = String(input.preferredDate);
  const duration = typeof input.duration === "number" ? input.duration : 30;
  const contactEmail = input.contactEmail ? String(input.contactEmail) : undefined;

  const isSalesRelated = purpose === "sales" || purpose === "ramy_support"
    || contactName.toLowerCase().includes("ramy");
  if (!isSalesRelated) {
    return `⚠️ SCOPE GATEKEEPER: This meeting doesn't appear to be sales-related or Ramy support. ${(process.env.TCC_USER_NAME || "Tony").split(/\s+/)[0]}'s priority: (1) Sales calls, (2) Ramy support, (3) everything else pushed to off-hours. Confirm this is a sales conversation or Ramy coordination.`;
  }

  const startDate = new Date(preferredDate);
  const pacificStart = new Date(startDate.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const startHour = pacificStart.getHours();
  if (startHour < 12 && contactEmail) {
    return `⛔ Morning Protection: ${(process.env.TCC_USER_NAME || "Tony").split(/\s+/)[0]}'s morning (before noon PT) is reserved for outbound calls only. No external meetings before noon. Please schedule this for 12 PM or later.`;
  }

  const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
  const result = await createEvent({
    summary: `Sales Call — ${contactName}`,
    description: `Purpose: ${purpose}. Scheduled via TCC AI.`,
    start: preferredDate,
    end: endDate.toISOString(),
    attendees: contactEmail ? [contactEmail] : undefined,
  });
  if (result.ok) return `✓ Meeting scheduled with ${contactName} for ${new Date(preferredDate).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", weekday: "short", month: "short", day: "numeric" })} (${duration} min). Event ID: ${result.eventId}`;
  if (result.error?.includes("not connected")) return `⚠️ Google Calendar not yet authorized`;
  return `✗ Failed to schedule meeting: ${result.error}`;
};

export default handler;
