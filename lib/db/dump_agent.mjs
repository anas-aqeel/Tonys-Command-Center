import pg from "pg";
import fs from "node:fs";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const agent = process.argv[2] || "orchestrator";
const r = await c.query(
  `SELECT agent, kind, section_name, length(content) chars, content
   FROM agent_memory_entries
   WHERE agent = $1 AND kind IN ('soul','user','skill','memory')
   ORDER BY kind, section_name`,
  [agent]
);

const dir = `/tmp/prompts/${agent}`;
fs.mkdirSync(dir, { recursive: true });
let summary = `=== ${agent.toUpperCase()} ===\n\n`;
for (const row of r.rows) {
  const file = `${dir}/${row.kind}__${row.section_name}.md`;
  fs.writeFileSync(file, row.content);
  summary += `${row.kind.padEnd(8)} | ${row.section_name.padEnd(30)} | ${String(row.chars).padStart(6)} chars (~${Math.round(row.chars/4)} tok) → ${file}\n`;
}
console.log(summary);

await c.end();
