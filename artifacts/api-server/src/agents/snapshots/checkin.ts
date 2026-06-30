// Checkin feedback snapshot — for guilt-trip "did this land?" thumbs feedback.

import { personalDb, checkinsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function captureCheckinSnapshot(
  skill: string,
  sourceId: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // sourceId is a checkin row id or a date string. Try uuid first, fall back to date.
  let checkin: any = null;

  if (sourceId && /^[0-9a-f-]{36}$/i.test(sourceId)) {
    const [c] = await personalDb.select().from(checkinsTable)
      .where(eq(checkinsTable.id, sourceId))
      .limit(1);
    checkin = c || null;
  } else if (sourceId && /^\d{4}-\d{2}-\d{2}$/.test(sourceId)) {
    const [c] = await personalDb.select().from(checkinsTable)
      .where(eq(checkinsTable.date, sourceId))
      .limit(1);
    checkin = c || null;
  }

  // Last 5 checkins for streak context
  const recentCheckins = await personalDb.select({
    date: checkinsTable.date,
    bedtime: checkinsTable.bedtime,
    sleep_hours: checkinsTable.sleepHours,
    bible: checkinsTable.bible,
    workout: checkinsTable.workout,
    journal: checkinsTable.journal,
  }).from(checkinsTable)
    .orderBy(desc(checkinsTable.date))
    .limit(5);

  return {
    checkin: checkin ? {
      id: checkin.id,
      date: checkin.date,
      sleep_hours: checkin.sleepHours,
      bible: checkin.bible,
      workout: checkin.workout,
      journal: checkin.journal,
      nutrition: checkin.nutrition,
    } : null,
    recent_checkins: recentCheckins,
    guilt_trip_text: extra?.guiltTripText || null,
    extra: extra || null,
  };
}
