import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// ─── Helper: parse a Supabase-style URL into Pool config ─────────────────────
function parseDbUrl(raw: string, maxConnections: number): pg.PoolConfig {
  const parsed = new URL(raw);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    ssl: { rejectUnauthorized: false },
    max: maxConnections,
  };
}

// ─── Dual Database Architecture ──────────────────────────────────────────────
//
//   PERSONAL_DATABASE_URL → user's own DB (personal + agent data)
//   SHARED_DATABASE_URL   → Tony's DB (business + contacts)
//
//   Backwards compat (Tony's instance):
//     If SHARED_DATABASE_URL is not set → sharedPool reuses personalPool
//     If PERSONAL_DATABASE_URL is not set → falls back to SUPABASE_DATABASE_URL / DATABASE_URL
//
//   NO `db` alias — every file must explicitly import `sharedDb` or `personalDb`.
//   This prevents silent wrong-DB bugs at compile time.

// ── Step 1: Resolve the personal pool (user's own DB) ────────────────────────
let personalPool: pg.Pool;

const personalUrl = process.env.PERSONAL_DATABASE_URL
  || process.env.SUPABASE_DATABASE_URL
  || process.env.DATABASE_URL;

if (!personalUrl) {
  throw new Error(
    "PERSONAL_DATABASE_URL (or SUPABASE_DATABASE_URL / DATABASE_URL) must be set."
  );
}

if (personalUrl.startsWith("postgresql://") || personalUrl.startsWith("postgres://")) {
  personalPool = new Pool(parseDbUrl(personalUrl, 10));
} else {
  personalPool = new Pool({ connectionString: personalUrl, max: 10 });
}

// ── Step 2: Resolve the shared pool (Tony's DB — business + contacts) ────────
let sharedPool: pg.Pool;
const sharedUrl = process.env.SHARED_DATABASE_URL;

if (sharedUrl) {
  if (sharedUrl.startsWith("postgresql://") || sharedUrl.startsWith("postgres://")) {
    sharedPool = new Pool(parseDbUrl(sharedUrl, 5));
  } else {
    sharedPool = new Pool({ connectionString: sharedUrl, max: 5 });
  }
} else {
  // No SHARED_DATABASE_URL → same DB for both (Tony's instance / legacy)
  sharedPool = personalPool;
}

// ── Idle connection error handlers ───────────────────────────────────────────
personalPool.on("error", (err) => {
  console.warn("[DB:personal] Idle pool client error (auto-reconnects on next query):", err.message);
});
if (sharedPool !== personalPool) {
  sharedPool.on("error", (err) => {
    console.warn("[DB:shared] Idle pool client error (auto-reconnects on next query):", err.message);
  });
}

// ── Log connection state ─────────────────────────────────────────────────────
const isSameDb = sharedPool === personalPool;
if (isSameDb) {
  console.log("[DB] Single-DB mode (shared + personal on same pool)");
} else {
  console.log("[DB] Dual-DB mode — shared: Tony's DB, personal: user's own DB");
}

// ── Drizzle instances ────────────────────────────────────────────────────────
export const personalDb = drizzle(personalPool, { schema });
export const sharedDb = isSameDb
  ? personalDb  // avoid creating two drizzle wrappers on the same pool
  : drizzle(sharedPool, { schema });

// Legacy export — routes that haven't been migrated yet can still import `db`.
// TODO: Remove once all routes explicitly use sharedDb / personalDb.
export const db = personalDb;

// Export pools for direct access (e.g., raw queries, health checks)
export { personalPool, sharedPool };

// Re-export the legacy `pool` name pointing to personalPool for backwards compat
export { personalPool as pool };

export * from "./schema";
