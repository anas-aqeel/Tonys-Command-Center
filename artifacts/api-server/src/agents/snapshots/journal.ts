// Journal feedback snapshot — for mood-correction / reflection thumbs.
// PRIVACY: Journal data is journal-agent-only. Snapshot still gets stored on
// agent_feedback (where Coach can read it), but per agents/journal/MEMORY/privacy-boundary,
// Coach is forbidden from cross-pollinating journal content into other agents' memory.

import { personalDb, journalsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function captureJournalSnapshot(
  skill: string,
  sourceId: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let entry: any = null;

  if (sourceId && /^[0-9a-f-]{36}$/i.test(sourceId)) {
    const [e] = await personalDb.select().from(journalsTable)
      .where(eq(journalsTable.id, sourceId))
      .limit(1);
    entry = e || null;
  } else if (sourceId && /^\d{4}-\d{2}-\d{2}$/.test(sourceId)) {
    const [e] = await personalDb.select().from(journalsTable)
      .where(eq(journalsTable.date, sourceId))
      .limit(1);
    entry = e || null;
  }

  // Recent journals for tone context (no full text — just metadata to preserve privacy boundary)
  const recentJournals = await personalDb.select({
    date: journalsTable.date,
    mood: journalsTable.mood,
  }).from(journalsTable)
    .orderBy(desc(journalsTable.date))
    .limit(5);

  return {
    entry: entry ? {
      id: entry.id,
      date: entry.date,
      raw_text: entry.rawText,
      formatted_text: entry.formattedText,
      mood: entry.mood,
      key_events: entry.keyEvents,
      reflection: entry.reflection,
    } : null,
    recent_journal_metadata: recentJournals,
    user_correction: extra?.userCorrection || null,
    extra: extra || null,
    privacy_boundary: "Coach must not propagate journal content into other agents' memory.",
  };
}
