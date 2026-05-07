import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const agent = process.argv[2] || "orchestrator";
const r = await c.query(
  `SELECT kind, section_name, length(content) chars FROM agent_memory_entries
   WHERE agent=$1 AND kind IN ('soul','user','skill','memory') ORDER BY kind, section_name`,
  [agent]
);
const total = r.rows.reduce((s, x) => s + Number(x.chars), 0);
console.log(`=== ${agent.toUpperCase()} live state (${r.rows.length} rows, ${total} chars, ~${Math.round(total/4)} tok) ===`);
for (const row of r.rows) {
  console.log(`  ${row.kind.padEnd(8)} | ${row.section_name.padEnd(30)} | ${String(row.chars).padStart(6)} chars`);
}

const a = await c.query(`SELECT count(*) n FROM agent_memory_entries_archive WHERE archive_reason=$1`, [`compress-${agent}-2026-05-06`]);
console.log(`\nArchive rows for compress-${agent}-2026-05-06: ${a.rows[0].n}`);
console.log(`Rollback command: node lib/db/rollback_compression.mjs "compress-${agent}-2026-05-06"`);

await c.end();
