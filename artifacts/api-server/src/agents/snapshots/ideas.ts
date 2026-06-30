// Ideas feedback snapshot — for classify thumbs / pushback override / generate-task feedback.
// Per FEEDBACK_SYSTEM.md §4.2: idea text + AI classification + 90-day plan + pushback shown + override decision.

import { sharedDb, personalDb, ideasTable, companyGoalsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function captureIdeasSnapshot(
  skill: string,
  sourceId: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [idea] = await personalDb.select().from(ideasTable)
    .where(eq(ideasTable.id, sourceId))
    .limit(1);

  const plan90 = await sharedDb.select({
    horizon: companyGoalsTable.horizon,
    title: companyGoalsTable.title,
    status: companyGoalsTable.status,
  }).from(companyGoalsTable)
    .orderBy(companyGoalsTable.position)
    .limit(15);

  // Recent ideas of similar category (for pattern context)
  let similarRecent: any[] = [];
  if (idea?.category) {
    similarRecent = await personalDb.select({
      id: ideasTable.id,
      text: ideasTable.text,
      category: ideasTable.category,
      urgency: ideasTable.urgency,
      status: ideasTable.status,
      override: ideasTable.override,
      createdAt: ideasTable.createdAt,
    }).from(ideasTable)
      .where(eq(ideasTable.category, idea.category))
      .orderBy(desc(ideasTable.createdAt))
      .limit(8);
  }

  return {
    idea: idea ? {
      id: idea.id,
      text: idea.text,
      category: idea.category,
      urgency: idea.urgency,
      tech_type: idea.techType,
      status: idea.status,
      override: idea.override,
      ai_reflection: idea.aiReflection,
    } : null,
    plan_90_day: plan90,
    similar_recent_ideas: similarRecent,
    pushback_message: extra?.pushbackMessage || null,
    override_justification: extra?.justification || null,
    extra: extra || null,
  };
}
