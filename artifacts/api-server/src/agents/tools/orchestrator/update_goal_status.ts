// update_goal_status — orchestrator wrapper. Mutates company_goals row,
// inserts goal_completions on done, and pushes the 411 sheet (silent on err).

import type { ToolHandler } from "../index.js";
import { sharedDb } from "@workspace/db";
import { companyGoalsTable, goalCompletionsTable } from "../../../lib/schema-v2.js";
import { eq } from "drizzle-orm";
import { push411ToSheet } from "../../../routes/tcc/business.js";

const handler: ToolHandler = async (input) => {
  try {
    if (!input.goal_id) return "goal_id is required";
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.status) {
      updates.status = String(input.status);
      if (input.status === "done") updates.completedAt = new Date();
    }
    if (input.owner) updates.owner = String(input.owner);
    if (input.due_date) updates.dueDate = String(input.due_date);
    const goalIdStr = String(input.goal_id);
    const [updated] = await sharedDb.update(companyGoalsTable).set(updates)
      .where(eq(companyGoalsTable.id, goalIdStr)).returning();
    if (!updated) return `Goal ${goalIdStr} not found`;
    if (input.status === "done") {
      await sharedDb.insert(goalCompletionsTable).values({
        goalId: goalIdStr, goalTitle: updated.title, horizon: updated.horizon,
      }).catch(() => {});
    }
    push411ToSheet().catch(() => {});
    return `✅ Goal updated: "${updated.title}" → status: ${updated.status}${input.owner ? `, owner: ${input.owner}` : ""}${input.due_date ? `, due: ${input.due_date}` : ""}`;
  } catch (err) {
    return `Failed to update goal: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export default handler;
