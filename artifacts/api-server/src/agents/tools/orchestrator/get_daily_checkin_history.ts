// get_daily_checkin_history — orchestrator wrapper. Reads tcc_checkins rows.

import type { ToolHandler } from "../index.js";
import { personalDb, checkinsTable } from "@workspace/db";
import { desc } from "drizzle-orm";

const handler: ToolHandler = async (input) => {
  const days = typeof input.days === "number" ? Math.min(input.days, 30) : 7;
  const rows = await personalDb.select().from(checkinsTable).orderBy(desc(checkinsTable.date)).limit(days);
  if (rows.length === 0) return "No check-in history found.";
  return rows.map((r, i) => {
    const parts = [`${i + 1}. [${r.date}]`];
    if (r.sleepHours != null) parts.push(`Sleep: ${r.sleepHours}h`);
    if (r.bible != null) parts.push(`Bible: ${r.bible ? "✓" : "✗"}`);
    if (r.workout != null) parts.push(`Workout: ${r.workout ? "✓" : "✗"}`);
    if (r.journal != null) parts.push(`Journal: ${r.journal ? "✓" : "✗"}`);
    if (r.nutrition) parts.push(`Nutrition: ${r.nutrition}`);
    if (r.unplug != null) parts.push(`Unplug: ${r.unplug ? "✓" : "✗"}`);
    return parts.join(" | ");
  }).join("\n");
};

export default handler;
