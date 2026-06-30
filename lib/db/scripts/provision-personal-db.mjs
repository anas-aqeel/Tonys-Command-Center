#!/usr/bin/env node
// provision-personal-db.mjs — One-command setup for a new user's personal database.
//
// Usage:
//   PERSONAL_DATABASE_URL="postgresql://..." node lib/db/scripts/provision-personal-db.mjs --user=ethan
//   PERSONAL_DATABASE_URL="postgresql://..." node lib/db/scripts/provision-personal-db.mjs --user=ethan --dry-run
//
// What it does:
//   1. Guard: same-DB detection (Tony's instance → skip)
//   2. Schema push via drizzle-kit (creates all tables)
//   3. Seed agent architecture from ai-outputs/ai-architecture/
//   4. Seed agent tools
//   5. Override _shared/USER.md with user profile
//   6. Verify all tables exist and agent data is seeded

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..", "..");

// ── Parse CLI args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const userArg = args.find(a => a.startsWith("--user="))?.split("=")[1];
const dryRun = args.includes("--dry-run");

if (!userArg) {
  console.error("Usage: node lib/db/scripts/provision-personal-db.mjs --user=<name> [--dry-run]");
  console.error("Example: PERSONAL_DATABASE_URL='...' node lib/db/scripts/provision-personal-db.mjs --user=ethan");
  process.exit(1);
}

const personalUrl = process.env.PERSONAL_DATABASE_URL;
const sharedUrl = process.env.SHARED_DATABASE_URL;

if (!personalUrl) {
  console.error("[PROVISION] PERSONAL_DATABASE_URL must be set.");
  process.exit(1);
}

// ── Step 1: Same-DB guard ────────────────────────────────────────────────────
if (sharedUrl && sharedUrl === personalUrl) {
  console.log("[PROVISION] Same-DB mode detected — SHARED and PERSONAL URLs match.");
  console.log("[PROVISION] This is Tony's instance. Skipping provisioning (DB already has all tables + data).");
  process.exit(0);
}

const userProfilePath = join(ROOT, "lib", "db", "seed-data", "user-profiles", `${userArg}.md`);
if (!existsSync(userProfilePath)) {
  console.error(`[PROVISION] User profile not found: ${userProfilePath}`);
  console.error(`[PROVISION] Create lib/db/seed-data/user-profiles/${userArg}.md first.`);
  process.exit(1);
}

console.log(`[PROVISION] Provisioning personal DB for user: ${userArg}`);
console.log(`[PROVISION] Target: ${personalUrl.replace(/:[^:@]+@/, ":***@")}`);
if (dryRun) console.log("[PROVISION] *** DRY RUN MODE — no changes will be made ***\n");

// ── Step 2: Schema push via drizzle-kit ──────────────────────────────────────
// Must use port 5432 (direct connection) for DDL, not 6543 (pooler).
console.log("\n[PROVISION] Step 2: Running drizzle-kit push...");

// For drizzle-kit, we need to convert the pooler URL (port 6543) to direct (port 5432)
const directUrl = personalUrl.replace(/:6543\//, ":5432/");

if (dryRun) {
  console.log(`  Would run: DATABASE_URL="${directUrl.replace(/:[^:@]+@/, ":***@")}" npx drizzle-kit push`);
} else {
  try {
    execSync(`npx drizzle-kit push`, {
      cwd: join(ROOT, "lib", "db"),
      env: { ...process.env, DATABASE_URL: directUrl },
      stdio: "inherit",
    });
    console.log("[PROVISION] Schema push complete.");
  } catch (err) {
    console.error("[PROVISION] Schema push failed:", err.message);
    process.exit(1);
  }
}

// ── Step 3: Seed agent architecture ──────────────────────────────────────────
console.log("\n[PROVISION] Step 3: Seeding agent architecture...");

if (dryRun) {
  console.log("  Would run: seed-agent-architecture.mjs");
} else {
  try {
    execSync(`node lib/db/scripts/seed-agent-architecture.mjs`, {
      cwd: ROOT,
      env: { ...process.env, SUPABASE_DATABASE_URL: personalUrl },
      stdio: "inherit",
    });
    console.log("[PROVISION] Agent architecture seeded.");
  } catch (err) {
    console.error("[PROVISION] Agent architecture seed failed:", err.message);
    // Non-fatal: continue
  }
}

// ── Step 4: Seed agent tools ─────────────────────────────────────────────────
console.log("\n[PROVISION] Step 4: Seeding agent tools...");

if (dryRun) {
  console.log("  Would run: seed-agent-tools.mjs");
} else {
  try {
    execSync(`node lib/db/scripts/seed-agent-tools.mjs`, {
      cwd: ROOT,
      env: { ...process.env, SUPABASE_DATABASE_URL: personalUrl },
      stdio: "inherit",
    });
    console.log("[PROVISION] Agent tools seeded.");
  } catch (err) {
    console.error("[PROVISION] Agent tools seed failed:", err.message);
    // Non-fatal: continue
  }
}

// ── Step 5: Override _shared/USER.md ─────────────────────────────────────────
console.log("\n[PROVISION] Step 5: Overriding _shared/USER.md with user profile...");

const userProfileContent = readFileSync(userProfilePath, "utf-8");
console.log(`  User profile: ${userProfilePath}`);
console.log(`  Content preview: ${userProfileContent.substring(0, 100).replace(/\n/g, " ")}...`);

if (dryRun) {
  console.log("  Would upsert agent_memory_entries row for _shared/USER.md");
} else {
  const { Pool } = pg;
  const parsed = new URL(personalUrl);
  const pool = new Pool({
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    ssl: { rejectUnauthorized: false },
  });

  try {
    // Upsert the USER.md memory entry
    await pool.query(`
      INSERT INTO agent_memory_entries (agent, kind, section_name, content, updated_by)
      VALUES ('_shared', 'identity', 'USER.md', $1, 'provision-script')
      ON CONFLICT (agent, kind, section_name) DO UPDATE
      SET content = $1, updated_by = 'provision-script', updated_at = NOW()
    `, [userProfileContent]);
    console.log("[PROVISION] User profile applied.");
  } catch (err) {
    console.error("[PROVISION] User profile override failed:", err.message);
  } finally {
    await pool.end();
  }
}

// ── Step 6: Verify ───────────────────────────────────────────────────────────
console.log("\n[PROVISION] Step 6: Verifying...");

if (dryRun) {
  console.log("  Would verify: all tables exist, agent data seeded");
  console.log("\n[PROVISION] Dry run complete. No changes were made.");
  process.exit(0);
}

const { Pool: VerifyPool } = pg;
const parsedVerify = new URL(personalUrl);
const verifyPool = new VerifyPool({
  host: parsedVerify.hostname,
  port: Number(parsedVerify.port) || 5432,
  user: decodeURIComponent(parsedVerify.username),
  password: decodeURIComponent(parsedVerify.password),
  database: parsedVerify.pathname.replace(/^\//, ""),
  ssl: { rejectUnauthorized: false },
});

try {
  // Check table count
  const tablesResult = await verifyPool.query(`
    SELECT COUNT(*) as count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const tableCount = parseInt(tablesResult.rows[0].count, 10);
  console.log(`  Tables created: ${tableCount}`);

  // Check agent data
  const memoryResult = await verifyPool.query(
    `SELECT COUNT(*) as count FROM agent_memory_entries`
  );
  const skillsResult = await verifyPool.query(
    `SELECT COUNT(*) as count FROM agent_skills`
  );
  const toolsResult = await verifyPool.query(
    `SELECT COUNT(*) as count FROM agent_tools`
  );
  console.log(`  Agent memory entries: ${memoryResult.rows[0].count}`);
  console.log(`  Agent skills: ${skillsResult.rows[0].count}`);
  console.log(`  Agent tools: ${toolsResult.rows[0].count}`);

  // Check user profile
  const userResult = await verifyPool.query(
    `SELECT content FROM agent_memory_entries WHERE agent = '_shared' AND section_name = 'USER.md' LIMIT 1`
  );
  if (userResult.rows.length > 0) {
    console.log(`  User profile: Applied (${userResult.rows[0].content.substring(0, 50)}...)`);
  } else {
    console.warn("  User profile: NOT FOUND — check seed step");
  }

  if (tableCount >= 40) {
    console.log("\n[PROVISION] Provisioning complete! DB is ready.");
  } else {
    console.warn(`\n[PROVISION] Warning: Only ${tableCount} tables found (expected ~50). Check drizzle-kit push output.`);
  }
} catch (err) {
  console.error("[PROVISION] Verification failed:", err.message);
} finally {
  await verifyPool.end();
}
