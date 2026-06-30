// Tasks feedback snapshot — for reorder, AI Organize thumbs, priority override.
// Per FEEDBACK_SYSTEM.md §4.2: reordered task + parent + siblings + 90-day plan.

import { sharedDb, personalDb, planItemsTable, brainTrainingLogTable, businessContextTable, companyGoalsTable } from "@workspace/db";
import { and, eq, desc, isNull } from "drizzle-orm";

export async function captureTasksSnapshot(
  skill: string,
  sourceId: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Fetch the task being acted on
  const [task] = await sharedDb.select().from(planItemsTable)
    .where(eq(planItemsTable.id, sourceId))
    .limit(1);

  // Parent (if any)
  let parent: any = null;
  if (task?.parentId) {
    const [p] = await sharedDb.select().from(planItemsTable)
      .where(eq(planItemsTable.id, task.parentId))
      .limit(1);
    parent = p || null;
  }

  // Siblings (top 10 of the same parent or root-level)
  const siblings = await sharedDb.select({
    id: planItemsTable.id,
    title: planItemsTable.title,
    priority: planItemsTable.priority,
    status: planItemsTable.status,
    priorityOrder: planItemsTable.priorityOrder,
  }).from(planItemsTable)
    .where(task?.parentId
      ? eq(planItemsTable.parentId, task.parentId)
      : isNull(planItemsTable.parentId))
    .orderBy(desc(planItemsTable.priorityOrder))
    .limit(10);

  // Recent training history (last 5 reorder explanations)
  const recentReorders = await personalDb.select({
    moved_item_title: brainTrainingLogTable.movedItemTitle,
    from_position: brainTrainingLogTable.fromPosition,
    to_position: brainTrainingLogTable.toPosition,
    tony_explanation: brainTrainingLogTable.tonyExplanation,
    ai_reflection: brainTrainingLogTable.aiReflection,
    created_at: brainTrainingLogTable.createdAt,
  }).from(brainTrainingLogTable)
    .orderBy(desc(brainTrainingLogTable.createdAt))
    .limit(5);

  // 90-day plan summary (titles only, top 20)
  const plan90 = await sharedDb.select({
    horizon: companyGoalsTable.horizon,
    title: companyGoalsTable.title,
    status: companyGoalsTable.status,
  }).from(companyGoalsTable)
    .orderBy(companyGoalsTable.position)
    .limit(20);

  // Business context summary
  let businessContext: string | null = null;
  try {
    const [bc] = await sharedDb.select().from(businessContextTable)
      .where(eq(businessContextTable.documentType, "business_plan"))
      .limit(1);
    businessContext = bc?.summary || null;
  } catch { /* optional */ }

  return {
    task: task ? {
      id: task.id,
      title: task.title,
      description: task.description,
      level: task.level,
      category: task.category,
      priority: task.priority,
      priority_order: task.priorityOrder,
      due_date: task.dueDate,
      status: task.status,
    } : null,
    parent: parent ? { id: parent.id, title: parent.title } : null,
    siblings,
    recent_reorders: recentReorders,
    plan_90_day_summary: plan90,
    business_context: businessContext,
    extra: extra || null,
  };
}
