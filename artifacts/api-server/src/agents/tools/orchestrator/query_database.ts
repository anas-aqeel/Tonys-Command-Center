// query_database — orchestrator wrapper. Read-only SELECT against PostgreSQL.
// Preserves the keyword-blocklist guard from claude.ts.
// Supports `target` param: "shared" (business/contacts DB) or "personal" (user's DB).

import type { ToolHandler } from "../index.js";
import { sharedDb, personalDb } from "@workspace/db";
import { sql } from "drizzle-orm";

const handler: ToolHandler = async (input) => {
  const rawSql = String(input.sql || input.query).trim();
  const target = String(input.target || "personal").toLowerCase();
  const upperSql = rawSql.toUpperCase();
  const blocked = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT", "REVOKE"];
  if (blocked.some(k => upperSql.includes(k))) {
    return `Only SELECT queries are allowed. Blocked keywords detected.`;
  }
  if (!upperSql.startsWith("SELECT")) {
    return `Only SELECT queries are allowed.`;
  }

  const db = target === "shared" ? sharedDb : personalDb;

  try {
    const result = await db.execute(sql.raw(rawSql));
    const rows = result.rows as Record<string, unknown>[];
    if (rows.length === 0) return "Query returned 0 rows.";
    const header = Object.keys(rows[0]).join(" | ");
    const divider = "-".repeat(header.length);
    const body = rows.slice(0, 50).map(r => Object.values(r).map(v => String(v ?? "")).join(" | ")).join("\n");
    return `${header}\n${divider}\n${body}\n\n(${rows.length} row${rows.length === 1 ? "" : "s"}${rows.length > 50 ? ", truncated to 50" : ""})`;
  } catch (err) {
    return `Query failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export default handler;
