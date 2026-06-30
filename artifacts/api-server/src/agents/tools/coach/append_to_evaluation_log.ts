// append_to_evaluation_log — Coach tool. Append a one-paragraph note to
// agent_memory_entries WHERE agent='coach' AND kind='memory' AND section_name='evaluation-log'.
//
// Only memory section Coach can write to on its OWN agent without a proposal.

import type { ToolHandler } from "../index.js";
import { personalDb, agentMemoryEntriesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

interface Input {
  agent: string;       // The TARGET agent the note is about (e.g. 'email').
                       // The log row itself always lives at agent='coach'.
  note: string;
}

const handler: ToolHandler = async (input, ctx) => {
  const { agent, note } = input as unknown as Input;
  if (!agent || typeof agent !== "string") {
    return { error: "agent is required (string)" };
  }
  if (!note || typeof note !== "string" || note.length < 5) {
    return { error: "note is required (≥5 chars)" };
  }

  // Build the entry (date-stamped, scoped by target agent + run id when available)
  const stamp = new Date().toISOString().slice(0, 10);
  const runRef = ctx.trainingRunId ? ` — run ${ctx.trainingRunId.slice(0, 8)}` : "";
  const entry = `\n\n## ${stamp}${runRef} — ${agent}\n${note.trim()}\n`;

  // Read existing log
  const [existing] = await personalDb.select().from(agentMemoryEntriesTable)
    .where(and(
      eq(agentMemoryEntriesTable.agent, "coach"),
      eq(agentMemoryEntriesTable.kind, "memory"),
      eq(agentMemoryEntriesTable.sectionName, "evaluation-log"),
    )).limit(1);

  if (existing) {
    await personalDb.update(agentMemoryEntriesTable).set({
      content: existing.content + entry,
      version: sql`${agentMemoryEntriesTable.version} + 1`,
      updatedAt: new Date(),
      updatedBy: "coach",
    }).where(eq(agentMemoryEntriesTable.id, existing.id));
  } else {
    // First write — initialize the section.
    await personalDb.insert(agentMemoryEntriesTable).values({
      agent: "coach",
      kind: "memory",
      sectionName: "evaluation-log",
      content: `# Evaluation Log${entry}`,
      updatedBy: "coach",
    });
  }

  return { ok: true, appended_chars: entry.length };
};

export default handler;
