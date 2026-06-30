// append_to_examples — Coach tool. Append a few-shot example to a specialist's
// examples-<skill>.md memory section.
//
// Only fires when the target skill's agent_skills.auto_examples = true.
// Used by the coach.append-example skill (Phase 2+, registered now).

import type { ToolHandler } from "../index.js";
import { personalDb, agentMemoryEntriesTable, agentSkillsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

interface Input {
  agent: string;
  skill: string;
  example: {
    input: string;
    output: string;
    why_good?: string;
  };
}

const handler: ToolHandler = async (input) => {
  const { agent, skill, example } = input as unknown as Input;
  if (!agent || !skill || !example?.input || !example?.output) {
    return { error: "agent, skill, example.input, example.output all required" };
  }

  // Check skill opt-in
  const [skillRow] = await personalDb.select().from(agentSkillsTable)
    .where(and(eq(agentSkillsTable.agent, agent), eq(agentSkillsTable.skillName, skill)))
    .limit(1);
  if (!skillRow) {
    return { error: `skill ${agent}.${skill} not found in registry` };
  }
  if (skillRow.autoExamples !== true) {
    return { error: `skill ${agent}.${skill} has auto_examples=false; append_to_examples refuses` };
  }

  const sectionName = `examples-${skill}`;
  const stamp = new Date().toISOString().slice(0, 10);
  const entry = `\n\n## Example added ${stamp}\n${example.why_good ? `**Why good:** ${example.why_good}\n\n` : ""}**Input:**\n\`\`\`\n${example.input}\n\`\`\`\n\n**Output:**\n\`\`\`\n${example.output}\n\`\`\`\n`;

  const [existing] = await personalDb.select().from(agentMemoryEntriesTable)
    .where(and(
      eq(agentMemoryEntriesTable.agent, agent),
      eq(agentMemoryEntriesTable.kind, "memory"),
      eq(agentMemoryEntriesTable.sectionName, sectionName),
    )).limit(1);

  if (existing) {
    await personalDb.update(agentMemoryEntriesTable).set({
      content: existing.content + entry,
      version: sql`${agentMemoryEntriesTable.version} + 1`,
      updatedAt: new Date(),
      updatedBy: "coach",
    }).where(eq(agentMemoryEntriesTable.id, existing.id));
  } else {
    await personalDb.insert(agentMemoryEntriesTable).values({
      agent,
      kind: "memory",
      sectionName,
      content: `# Examples — ${skill}${entry}`,
      updatedBy: "coach",
    });
  }

  return { ok: true, section: sectionName, appended_chars: entry.length };
};

export default handler;
