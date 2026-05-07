// Usage:  node rollback_compression.mjs "<archive_reason>"
// Restores all rows archived under that reason to their previous content.
import pg from "pg";
const [, , reason] = process.argv;
if (!reason) { console.error("usage: node rollback_compression.mjs '<archive_reason>'"); process.exit(1); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query("BEGIN");
try {
  const r = await c.query(
    `SELECT * FROM agent_memory_entries_archive WHERE archive_reason=$1 ORDER BY archived_at DESC`,
    [reason]
  );
  console.log(`Found ${r.rows.length} archived rows for reason='${reason}'`);
  let restored = 0;
  for (const row of r.rows) {
    await c.query(
      `UPDATE agent_memory_entries SET content=$1, updated_at=now() WHERE id=$2`,
      [row.old_content, row.original_id]
    );
    console.log(`RESTORED ${row.agent}/${row.kind}/${row.section_name}`);
    restored++;
  }
  await c.query("COMMIT");
  console.log(`\n=== Restored ${restored} rows ===`);
} catch (err) {
  await c.query("ROLLBACK");
  console.error("ROLLBACK:", err.message);
  process.exit(2);
}
await c.end();
