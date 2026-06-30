// get_411_plan — orchestrator wrapper. Returns FlipIQ's 411 goal cascade,
// optionally filtered by horizon/owner/status, grouped by horizon order.

import type { ToolHandler } from "../index.js";
import { sharedDb } from "@workspace/db";
import { companyGoalsTable } from "../../../lib/schema-v2.js";
import { asc } from "drizzle-orm";

const handler: ToolHandler = async (input) => {
  try {
    const goals = await sharedDb.select().from(companyGoalsTable)
      .orderBy(asc(companyGoalsTable.position), asc(companyGoalsTable.createdAt));
    let filtered = goals;
    if (input.horizon) filtered = filtered.filter((g: typeof goals[0]) => g.horizon === String(input.horizon));
    if (input.owner) filtered = filtered.filter((g: typeof goals[0]) => g.owner?.toLowerCase().includes(String(input.owner).toLowerCase()));
    if (input.status) filtered = filtered.filter((g: typeof goals[0]) => g.status === String(input.status));
    if (filtered.length === 0) return "No goals found matching those filters.";
    const HORIZON_ORDER_LOCAL = ["5yr", "1yr", "quarterly", "monthly", "weekly", "daily"];
    const grouped: Record<string, typeof filtered> = {};
    for (const h of HORIZON_ORDER_LOCAL) grouped[h] = [];
    for (const g of filtered) {
      const h = g.horizon || "other";
      if (!grouped[h]) grouped[h] = [];
      grouped[h].push(g);
    }
    const lines: string[] = ["## FlipIQ 411 Goal Plan\n"];
    for (const h of HORIZON_ORDER_LOCAL) {
      const items = grouped[h];
      if (!items || items.length === 0) continue;
      lines.push(`### ${h.toUpperCase()}`);
      for (const g of items) {
        const statusIcon = g.status === "done" ? "✅" : g.status === "paused" ? "⏸️" : "🎯";
        lines.push(`${statusIcon} [${g.id.slice(0, 8)}] **${g.title}** — Owner: ${g.owner || "TBD"}${g.dueDate ? ` | Due: ${g.dueDate}` : ""}`);
        if (g.description) lines.push(`   ${g.description}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  } catch (err) {
    return `Failed to get 411 plan: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export default handler;
