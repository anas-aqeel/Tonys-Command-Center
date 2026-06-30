// Schedule feedback snapshot — for force-override on scope-block.
// Caller passes meeting metadata + scope-gatekeeper decision via `extra`.

import { personalDb, manualScheduleEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function captureScheduleSnapshot(
  skill: string,
  sourceId: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // sourceId may be the manual_schedule_events id, or a Google event id (string).
  // Try DB lookup; fall back to extra-only.
  let event: any = null;
  try {
    if (sourceId && /^[0-9a-f-]{36}$/i.test(sourceId)) {
      const [e] = await personalDb.select().from(manualScheduleEventsTable)
        .where(eq(manualScheduleEventsTable.id, sourceId))
        .limit(1);
      event = e || null;
    }
  } catch { /* not a uuid or table miss */ }

  return {
    event_id: sourceId,
    event: event ? {
      title: event.title,
      type: event.type,
      category: event.category,
      date: event.date,
      time: event.time,
      time_end: event.timeEnd,
      person: event.person,
      forced_override: event.forcedOverride,
      override_reason: event.overrideReason,
    } : null,
    scope_decision: extra?.scope || null,
    scope_warning: extra?.scopeWarning || null,
    calls_made_today: extra?.callsMade ?? null,
    quota_target: extra?.quotaTarget ?? null,
    proposed_title: extra?.title || null,
    proposed_time: extra?.startTime || null,
    extra: extra || null,
  };
}
