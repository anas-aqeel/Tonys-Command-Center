// Apply 2026-05-07-skill-key-override.sql against $DATABASE_URL.
// Same shape as add-contact-columns.mjs — node-runner pattern for ad-hoc
// idempotent migrations. Safe to re-run.

import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, "migrations", "2026-05-07-skill-key-override.sql");

// Lazy .env loader — picks up DATABASE_URL from repo root if not already set.
if (!process.env.DATABASE_URL) {
  const repoEnv = join(__dirname, "..", "..", "..", ".env");
  try {
    const text = readFileSync(repoEnv, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    // No .env at root — caller can still pass DATABASE_URL via shell.
  }
}

(async () => {
  const sql = readFileSync(sqlPath, "utf8");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(sql);
  const r = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'agent_skills'
      AND column_name IN ('api_key_cipher', 'base_url')
    ORDER BY column_name;
  `);
  console.log("agent_skills override cols:", r.rows);
  await client.end();
})().catch((err) => { console.error(err); process.exit(1); });
