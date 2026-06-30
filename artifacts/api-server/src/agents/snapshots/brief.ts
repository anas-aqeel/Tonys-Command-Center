// Brief feedback snapshot — for daily-brief / spiritual-anchor / EOD feedback.

import { personalDb, dailyBriefsTable, eodReportsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function captureBriefSnapshot(
  skill: string,
  sourceId: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let brief: any = null;
  let eod: any = null;

  // Try daily brief by id or date
  if (sourceId && /^[0-9a-f-]{36}$/i.test(sourceId)) {
    const [b] = await personalDb.select().from(dailyBriefsTable)
      .where(eq(dailyBriefsTable.id, sourceId))
      .limit(1);
    brief = b || null;

    if (!brief) {
      const [e] = await personalDb.select().from(eodReportsTable)
        .where(eq(eodReportsTable.id, sourceId))
        .limit(1);
      eod = e || null;
    }
  } else if (sourceId && /^\d{4}-\d{2}-\d{2}$/.test(sourceId)) {
    const [b] = await personalDb.select().from(dailyBriefsTable)
      .where(eq(dailyBriefsTable.date, sourceId))
      .limit(1);
    brief = b || null;
  }

  // Recent briefs for context
  const recentBriefs = await personalDb.select({
    date: dailyBriefsTable.date,
  }).from(dailyBriefsTable)
    .orderBy(desc(dailyBriefsTable.date))
    .limit(5);

  return {
    brief: brief ? {
      id: brief.id,
      date: brief.date,
      tasks_count: Array.isArray(brief.tasks) ? brief.tasks.length : null,
      important_count: Array.isArray(brief.emailsImportant) ? brief.emailsImportant.length : null,
    } : null,
    eod: eod ? {
      id: eod.id,
      date: eod.date,
      report_text: eod.reportText,
      calls_made: eod.callsMade,
      demos_booked: eod.demosBooked,
      tasks_completed: eod.tasksCompleted,
    } : null,
    recent_brief_dates: recentBriefs.map(b => b.date),
    skill_specific: extra?.skillSpecific || null,
    edited_text: extra?.editedText || null,
    extra: extra || null,
  };
}
