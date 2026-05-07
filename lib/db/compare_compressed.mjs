import pg from "pg";
import fs from "node:fs";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const changes = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

let totalOld = 0, totalNew = 0;
console.log("agent           | kind     | section                        | old chars | new chars | reduction");
console.log("----------------|----------|--------------------------------|-----------|-----------|----------");
for (const ch of changes) {
  const r = await c.query(
    `SELECT length(content) as len FROM agent_memory_entries WHERE agent=$1 AND kind=$2 AND section_name=$3`,
    [ch.agent, ch.kind, ch.section_name]
  );
  const oldLen = r.rows[0]?.len ?? 0;
  const newLen = ch.new_content.length;
  totalOld += oldLen;
  totalNew += newLen;
  const pct = oldLen ? Math.round((1 - newLen / oldLen) * 100) : 0;
  console.log(
    `${ch.agent.padEnd(15)} | ${ch.kind.padEnd(8)} | ${ch.section_name.padEnd(30)} | ${String(oldLen).padStart(9)} | ${String(newLen).padStart(9)} | ${String(pct).padStart(7)}%`
  );
}
const totalPct = Math.round((1 - totalNew / totalOld) * 100);
console.log(`\nTOTAL: ${totalOld} → ${totalNew} chars (${totalPct}% smaller, ~${Math.round((totalOld - totalNew) / 4)} tokens saved per call)`);
await c.end();
