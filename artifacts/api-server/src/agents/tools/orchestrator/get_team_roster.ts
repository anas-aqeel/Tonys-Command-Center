// get_team_roster — orchestrator wrapper. Returns FlipIQ team_roles rows.

import type { ToolHandler } from "../index.js";
import { sharedDb } from "@workspace/db";
import { teamRolesTable } from "../../../lib/schema-v2.js";
import { asc } from "drizzle-orm";

const handler: ToolHandler = async () => {
  try {
    const team = await sharedDb.select().from(teamRolesTable)
      .orderBy(asc(teamRolesTable.position), asc(teamRolesTable.name));
    if (team.length === 0) return "No team roster found. The Business Brain has no team members yet.";
    const lines = ["## FlipIQ Team Roster\n"];
    for (const m of team) {
      lines.push(`**${m.name}** — ${m.role}`);
      if (m.email) lines.push(`  Email: ${m.email}`);
      if (m.slackId) lines.push(`  Slack: ${m.slackId}`);
      if (m.currentFocus) lines.push(`  Current Focus: ${m.currentFocus}`);
      if (m.responsibilities && Array.isArray(m.responsibilities) && m.responsibilities.length > 0) {
        lines.push(`  Responsibilities: ${(m.responsibilities as string[]).join(", ")}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  } catch (err) {
    return `Failed to get team roster: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export default handler;
