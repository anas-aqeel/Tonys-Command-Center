// read_agent_files — Coach tool. Wide read of one agent's full memory state.
// Returns every agent_memory_entries row for the requested agent.

import type { ToolHandler } from "../index.js";
import { personalDb, agentMemoryEntriesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";

interface Input {
  agent: string;
}

const handler: ToolHandler = async (input) => {
  const { agent } = input as unknown as Input;
  if (!agent || typeof agent !== "string") {
    return { error: "agent is required (string)" };
  }

  const rows = await personalDb.select({
    kind: agentMemoryEntriesTable.kind,
    section_name: agentMemoryEntriesTable.sectionName,
    content: agentMemoryEntriesTable.content,
    version: agentMemoryEntriesTable.version,
    updated_at: agentMemoryEntriesTable.updatedAt,
    updated_by: agentMemoryEntriesTable.updatedBy,
  })
    .from(agentMemoryEntriesTable)
    .where(eq(agentMemoryEntriesTable.agent, agent))
    .orderBy(asc(agentMemoryEntriesTable.kind), asc(agentMemoryEntriesTable.sectionName));

  return { agent, count: rows.length, entries: rows };
};

export default handler;
