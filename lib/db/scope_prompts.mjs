import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

console.log("=== LIVE-LOADED CONTENT PER AGENT (soul + user + skill bodies + memory) ===");
console.log("(agents/identity/tools layers are NOT loaded into prompts per prompt-builder.ts)\n");

const r = await c.query(`
  SELECT agent,
         sum(CASE WHEN kind IN ('soul','user') THEN length(content) ELSE 0 END) as l1_l2_chars,
         sum(CASE WHEN kind = 'skill' THEN length(content) ELSE 0 END) as skill_chars,
         sum(CASE WHEN kind = 'memory' THEN length(content) ELSE 0 END) as memory_chars,
         sum(length(content)) as total_loadable_chars
  FROM agent_memory_entries
  WHERE kind IN ('soul','user','skill','memory')
  GROUP BY agent
  ORDER BY total_loadable_chars DESC
`);
for (const row of r.rows) {
  const tok = Math.round(row.total_loadable_chars / 4);
  console.log(`${row.agent.padEnd(15)} | live-loaded: ${String(row.total_loadable_chars).padStart(6)} chars (~${tok} tok) | soul+user: ${row.l1_l2_chars} | skill: ${row.skill_chars} | memory: ${row.memory_chars}`);
}

const t = await c.query(`SELECT sum(length(content)) c FROM agent_memory_entries WHERE kind IN ('soul','user','skill','memory')`);
console.log(`\nTOTAL live-loaded across all agents: ${t.rows[0].c} chars (~${Math.round(t.rows[0].c/4)} tokens)`);

console.log("\n=== TYPICAL PER-CALL LOAD (one agent + one skill, no memory sections) ===");
const t2 = await c.query(`
  SELECT a.agent,
         (SELECT sum(length(content)) FROM agent_memory_entries WHERE agent='_shared' AND kind IN ('soul','user')) as global_chars,
         (SELECT sum(length(content)) FROM agent_memory_entries WHERE agent=a.agent AND kind IN ('soul','user')) as agent_chars,
         (SELECT avg(length(content)) FROM agent_memory_entries WHERE agent=a.agent AND kind = 'skill') as avg_skill_chars
  FROM (SELECT DISTINCT agent FROM agent_memory_entries WHERE agent <> '_shared') a
  ORDER BY a.agent
`);
for (const row of t2.rows) {
  const total = Number(row.global_chars||0) + Number(row.agent_chars||0) + Number(row.avg_skill_chars||0);
  console.log(`${row.agent.padEnd(15)} | global: ${row.global_chars||0} | agent: ${row.agent_chars||0} | avg-skill: ${Math.round(row.avg_skill_chars||0)} | TOTAL: ${Math.round(total)} chars (~${Math.round(total/4)} tok)`);
}

await c.end();
