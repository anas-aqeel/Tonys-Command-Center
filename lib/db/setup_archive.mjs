import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

await c.query(`
  CREATE TABLE IF NOT EXISTS agent_memory_entries_archive (
    id              bigserial PRIMARY KEY,
    original_id     uuid NOT NULL,
    agent           text NOT NULL,
    kind            text NOT NULL,
    section_name    text NOT NULL,
    old_content     text NOT NULL,
    archive_reason  text NOT NULL,
    archived_at     timestamptz NOT NULL DEFAULT now()
  )
`);

await c.query(`
  CREATE INDEX IF NOT EXISTS agent_memory_entries_archive_lookup_idx
  ON agent_memory_entries_archive (agent, kind, section_name, archived_at DESC)
`);

const cols = await c.query(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'agent_memory_entries_archive'
  ORDER BY ordinal_position
`);
console.log("=== Archive table created ===");
console.log(JSON.stringify(cols.rows, null, 2));

const orig = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_memory_entries' AND column_name = 'id'`);
console.log("\nLive table 'id' column:", orig.rows[0]);

await c.end();
