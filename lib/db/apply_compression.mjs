// Usage:  node apply_compression.mjs <changes.json> "<reason>"
// changes.json: [{ agent, kind, section_name, new_content }, ...]
import pg from "pg";
import fs from "node:fs";
const [, , file, reason] = process.argv;
if (!file || !reason) { console.error("usage: node apply_compression.mjs <changes.json> '<reason>'"); process.exit(1); }
const changes = JSON.parse(fs.readFileSync(file, "utf8"));
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query("BEGIN");
let applied = 0, skipped = 0;
try {
  for (const ch of changes) {
    const { agent, kind, section_name, new_content } = ch;
    const r = await c.query(
      `SELECT id, content FROM agent_memory_entries WHERE agent=$1 AND kind=$2 AND section_name=$3`,
      [agent, kind, section_name]
    );
    if (r.rows.length === 0) { console.warn(`SKIP ${agent}/${kind}/${section_name} — no row`); skipped++; continue; }
    const row = r.rows[0];
    if (row.content === new_content) { console.log(`NOOP ${agent}/${kind}/${section_name} — content identical`); skipped++; continue; }
    await c.query(
      `INSERT INTO agent_memory_entries_archive (original_id, agent, kind, section_name, old_content, archive_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, agent, kind, section_name, row.content, reason]
    );
    await c.query(
      `UPDATE agent_memory_entries SET content=$1, updated_at=now() WHERE id=$2`,
      [new_content, row.id]
    );
    const oldLen = row.content.length;
    const newLen = new_content.length;
    const pct = Math.round((1 - newLen / oldLen) * 100);
    console.log(`OK   ${agent}/${kind}/${section_name}: ${oldLen} → ${newLen} chars (${pct}% smaller)`);
    applied++;
  }
  await c.query("COMMIT");
  console.log(`\n=== Applied ${applied}, skipped ${skipped} ===`);
} catch (err) {
  await c.query("ROLLBACK");
  console.error("ROLLBACK:", err.message);
  process.exit(2);
}
await c.end();
