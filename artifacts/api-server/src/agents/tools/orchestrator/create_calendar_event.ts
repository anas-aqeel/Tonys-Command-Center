// create_calendar_event — orchestrator wrapper. Creates a Google Calendar event.
// Preserves the scope-gatekeeper warning + morning-protection advisory exactly as
// claude.ts implements them today.

import type { ToolHandler } from "../index.js";
import { createEvent } from "../../../lib/gcal.js";

const handler: ToolHandler = async (input) => {
  const purpose = input.purpose ? String(input.purpose).toLowerCase() : "";
  const summaryLower = String(input.summary || "").toLowerCase();
  const isSalesRelated = purpose === "sales" || purpose === "ramy_support"
    || summaryLower.includes("sales") || summaryLower.includes("prospect")
    || summaryLower.includes("call") || summaryLower.includes("demo")
    || summaryLower.includes("ramy") || summaryLower.includes("follow up");

  if (!isSalesRelated && purpose !== "sales" && purpose !== "ramy_support") {
    return `⚠️ SCOPE GATEKEEPER: This event ("${input.summary}") doesn't appear to be sales-related or Ramy support. ${(process.env.TCC_USER_NAME || "Tony").split(/\s+/)[0]}'s priority: (1) Sales calls, (2) Ramy support, (3) everything else pushed to off-hours. Confirm this is necessary or reschedule outside prime selling hours (9AM–5PM PT).`;
  }

  const startStr = String(input.start);
  const startDate = new Date(startStr);
  const pacificStart = new Date(startDate.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const startHour = pacificStart.getHours();
  const hasAttendees = Array.isArray(input.attendees) && input.attendees.length > 0;
  if (startHour < 12 && hasAttendees) {
    return `⛔ Morning Protection: Tony's morning (before noon PT) is reserved for outbound sales calls only. No external meetings allowed before noon. Please schedule this for 12 PM or later, or use the afternoon block (2–5 PM). If this is truly urgent, Tony can override manually on his calendar.`;
  }
  const result = await createEvent({
    summary: String(input.summary),
    description: input.description ? String(input.description) : undefined,
    start: startStr,
    end: String(input.end),
    attendees: hasAttendees ? (input.attendees as string[]).map(String) : undefined,
  });
  if (result.ok) return `✓ Calendar event created: "${input.summary}" (id: ${result.eventId})`;
  if (result.error?.includes("not connected")) return `⚠️ Google Calendar not yet authorized`;
  return `✗ Event creation failed: ${result.error}`;
};

export default handler;
