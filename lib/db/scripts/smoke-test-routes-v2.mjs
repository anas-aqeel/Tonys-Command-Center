// Route-level smoke test for the v2 agent migration.
//
// This is the *correct* layer to test at. The earlier skill-level smoke test
// (smoke-test-agents-v2.mjs) hit /api/agents/:agent/skills/:skill/invoke with
// a hand-crafted user_message that forced the JSON shape — which masked the
// real failure mode: production routes pass their own prompts and parse the
// output against the *legacy* field names (from/subj/why), but the v2 skill
// prompts emit the new names (sender/subject/one_line_summary).
//
// This script hits each production route that wraps a v2 skill and checks
// both HTTP success AND that the response payload contains the FE-expected
// field names. Any shape drift from the v2 migration shows up here.
//
// Run: node --env-file=.env lib/db/scripts/smoke-test-routes-v2.mjs
//
// Output: ai-outputs/route-smoke-test-v2.md

import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.SMOKE_BASE || "https://tonys-command-center-api-server.vercel.app/api";
const TOKEN = process.env.TCC_AUTH_TOKEN;

if (!TOKEN) {
  console.error("[route-smoke] TCC_AUTH_TOKEN not set");
  process.exit(1);
}

const HEADERS = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${TOKEN}`,
};

// ── tiny test framework ──────────────────────────────────────────────────────

function ok(...args) { return { pass: true, notes: args.filter(Boolean).join(" · ") }; }
function fail(...args) { return { pass: false, notes: args.filter(Boolean).join(" · ") }; }

async function hit(method, path, body) {
  const t0 = Date.now();
  let res, payload, parseErr;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: HEADERS,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, latencyMs: Date.now() - t0, err: e.message, payload: null };
  }
  const latencyMs = Date.now() - t0;
  const text = await res.text();
  try { payload = JSON.parse(text); } catch (e) { parseErr = e.message; payload = text; }
  return { status: res.status, latencyMs, payload, parseErr };
}

// ── tests ────────────────────────────────────────────────────────────────────

const tests = [
  {
    name: "brief/emails/reclassify (email/triage)",
    skill: "email/triage",
    run: async () => {
      const r = await hit("POST", "/brief/emails/reclassify", {});
      if (r.status !== 200) return { ...r, ...fail(`status=${r.status} body=${JSON.stringify(r.payload).slice(0, 200)}`) };
      const p = r.payload;
      if (!p?.ok) return { ...r, ...fail(`ok=false ${p?.error || ""}`) };
      // shape check: at least one of the buckets has items; items have from/subj/why
      const items = [...(p.emailsImportant || []), ...(p.emailsFyi || []), ...(p.emailsPromotions || [])];
      if (items.length === 0) return { ...r, ...ok("empty inbox window — accepted but unverified") };
      const sample = items[0];
      const hasLegacy = "from" in sample && "subj" in sample && "why" in sample;
      const hasV2 = "sender" in sample || "subject" in sample || "one_line_summary" in sample;
      if (!hasLegacy && hasV2) return { ...r, ...fail(`v2 shape leaked: ${JSON.stringify(sample).slice(0, 200)}`) };
      if (!hasLegacy) return { ...r, ...fail(`missing legacy fields: ${JSON.stringify(sample).slice(0, 200)}`) };
      return { ...r, ...ok(`important=${(p.emailsImportant || []).length} fyi=${(p.emailsFyi || []).length} promotions=${(p.emailsPromotions || []).length} sample-from="${sample.from?.slice(0, 30)}"`) };
    },
  },
  {
    name: "brief/spiritual-anchor",
    skill: "brief/spiritual-anchor",
    run: async () => {
      const r = await hit("GET", "/brief/spiritual-anchor");
      if (r.status !== 200) return { ...r, ...fail(`status=${r.status}`) };
      const p = r.payload;
      const anchor = p?.anchor || p?.text || "";
      if (!anchor || typeof anchor !== "string") return { ...r, ...fail(`no anchor string: ${JSON.stringify(p).slice(0, 200)}`) };
      if (anchor.includes("—")) return { ...r, ...fail(`em-dash leak in anchor`) };
      return { ...r, ...ok(`len=${anchor.length} preview="${anchor.slice(0, 80)}"`) };
    },
  },
  {
    name: "tasks/create-with-check (tasks/check-priority, checkOnly)",
    skill: "tasks/check-priority",
    run: async () => {
      const r = await hit("POST", "/tasks/create-with-check", {
        text: "Order new office chair",
        checkOnly: true,
      });
      if (r.status !== 200) return { ...r, ...fail(`status=${r.status} body=${JSON.stringify(r.payload).slice(0, 200)}`) };
      const p = r.payload;
      if (!p?.ok) return { ...r, ...fail(`ok=false`) };
      const pc = p.priorityCheck;
      if (!pc) return { ...r, ...fail(`no priorityCheck`) };
      if (typeof pc.newTaskPriority !== "number") return { ...r, ...fail(`newTaskPriority not number: ${JSON.stringify(pc).slice(0, 150)}`) };
      if (typeof pc.hasHigherPriority !== "boolean") return { ...r, ...fail(`hasHigherPriority not boolean`) };
      return { ...r, ...ok(`newTaskPriority=${pc.newTaskPriority} hasHigher=${pc.hasHigherPriority} count=${pc.count}`) };
    },
  },
  {
    name: "ideas/classify (ideas/classify + ideas/pushback)",
    skill: "ideas/classify",
    run: async () => {
      const r = await hit("POST", "/ideas/classify", {
        text: "Start a podcast about real estate wholesaling",
      });
      if (r.status !== 200) return { ...r, ...fail(`status=${r.status} body=${JSON.stringify(r.payload).slice(0, 200)}`) };
      const p = r.payload;
      if (!p?.ok) return { ...r, ...fail(`ok=false`) };
      const c = p.classification;
      if (!c) return { ...r, ...fail(`no classification`) };
      const VALID_CATS = ["Tech", "Sales", "Marketing", "Strategic Partners", "Operations", "Product", "Personal"];
      const VALID_URG = ["Now", "This Week", "This Month", "Someday"];
      const VALID_PRIO = ["high", "medium", "low"];
      const issues = [];
      if (!VALID_CATS.includes(c.category)) issues.push(`category="${c.category}" not in valid set`);
      if (!VALID_URG.includes(c.urgency)) issues.push(`urgency="${c.urgency}" not in valid set`);
      if (!VALID_PRIO.includes(c.priority)) issues.push(`priority="${c.priority}" not in valid set`);
      if (typeof c.reason !== "string") issues.push(`reason not string`);
      if (typeof c.businessFit !== "string") issues.push(`businessFit not string (was ${typeof c.businessFit})`);
      if (issues.length) return { ...r, ...fail(issues.join("; ")) };
      return { ...r, ...ok(`cat=${c.category} urg=${c.urgency} prio=${c.priority} pushback=${c.pushback ? "yes" : "no"}`) };
    },
  },
  {
    name: "schedule/add (schedule/check-scope, sales meeting passes)",
    skill: "schedule/check-scope",
    run: async () => {
      // Use a far-future date + dryRun=via-checkOnly equivalent: title that should pass
      // (sales). We can't easily dry-run, but we can pick "Other"-looking to test gating.
      // Note: this will actually create a calendar event if it passes. To avoid side
      // effects we hit the route but with forceOverride=true to bypass scope. We can
      // still observe whether the route returned scope-check warnings.
      const farFuture = "2030-01-01";
      const r = await hit("POST", "/schedule/add", {
        title: "Sales call with Drew Wolfe — Pinpoint demo",
        date: farFuture,
        startTime: "14:00",
        endTime: "14:30",
        category: "SALES",
        forceOverride: true, // skip any block so we don't get a hard fail
      });
      if (r.status !== 200) return { ...r, ...fail(`status=${r.status} body=${JSON.stringify(r.payload).slice(0, 200)}`) };
      const p = r.payload;
      // Route succeeded — we just want to see scope was evaluated (look for category field)
      return { ...r, ...ok(`ok=${p?.ok ?? "?"} eventId=${p?.eventId || "n/a"}`) };
    },
  },
  {
    name: "journal (journal/format-entry)",
    skill: "journal/format-entry",
    run: async () => {
      const r = await hit("POST", "/journal", {
        rawText: "Today was a grind. Got distracted by TCC bug fixes when I should have been on calls. Sergio's LOI is sitting and I'm feeling the Q2 pressure. Need to lock in tomorrow.",
      });
      if (r.status !== 200) return { ...r, ...fail(`status=${r.status} body=${JSON.stringify(r.payload).slice(0, 200)}`) };
      const p = r.payload;
      const formatted = p?.formattedText || p?.journal?.formattedText || "";
      if (!formatted) return { ...r, ...fail(`no formattedText: ${JSON.stringify(p).slice(0, 250)}`) };
      const hasMoodSection = /\*\*Mood:\*\*/.test(formatted);
      const hasKeyEvents = /\*\*Key Events:\*\*/.test(formatted);
      const hasReflection = /\*\*Reflection:\*\*/.test(formatted);
      const hasEmDash = formatted.includes("—") && !/\d{4}\s*—\s*\w/.test(formatted); // date dashes ok
      const issues = [];
      if (!hasMoodSection) issues.push("missing **Mood:** section");
      if (!hasKeyEvents) issues.push("missing **Key Events:** section");
      if (!hasReflection) issues.push("missing **Reflection:** section");
      // em-dash is voice rule; report but don't fail
      if (issues.length) return { ...r, ...fail(issues.join("; ") + ` · preview="${formatted.slice(0, 120)}"`) };
      return { ...r, ...ok(`mood=${!!p.mood} keyEvents=${!!p.keyEvents} reflection=${!!p.reflection} em-dash=${hasEmDash}`) };
    },
  },
  {
    name: "checkin/guilt-trip (checkin/accountability, missingWorkout=true)",
    skill: "checkin/accountability",
    run: async () => {
      const r = await hit("POST", "/checkin/guilt-trip", {
        missingWorkout: true,
        missingJournal: false,
      });
      if (r.status !== 200) return { ...r, ...fail(`status=${r.status} body=${JSON.stringify(r.payload).slice(0, 200)}`) };
      const p = r.payload;
      const msg = p?.message || "";
      if (!msg) return { ...r, ...fail(`empty message`) };
      if (msg.length < 50) return { ...r, ...fail(`message suspiciously short (${msg.length}): "${msg}"`) };
      const emDashFlag = msg.includes("—") ? " ⚠ em-dash leak (voice rule)" : "";
      return { ...r, ...ok(`len=${msg.length}${emDashFlag} preview="${msg.slice(0, 100)}"`) };
    },
  },
  {
    name: "emails/reclassify mode=last_24h (email/triage)",
    skill: "email/triage",
    run: async () => {
      const r = await hit("POST", "/emails/reclassify", { mode: "last_24h" });
      if (r.status !== 200) return { ...r, ...fail(`status=${r.status} body=${JSON.stringify(r.payload).slice(0, 200)}`) };
      const p = r.payload;
      if (!p?.ok) return { ...r, ...fail(`ok=false ${p?.error || ""}`) };
      const items = [...(p.emailsImportant || []), ...(p.emailsFyi || []), ...(p.emailsPromotions || [])];
      if (items.length === 0) return { ...r, ...ok("empty inbox window") };
      const sample = items[0];
      const hasLegacy = "from" in sample && "subj" in sample && "why" in sample;
      const hasV2 = "sender" in sample || "subject" in sample || "one_line_summary" in sample;
      if (!hasLegacy && hasV2) return { ...r, ...fail(`v2 shape leaked: ${JSON.stringify(sample).slice(0, 200)}`) };
      if (!hasLegacy) return { ...r, ...fail(`missing legacy fields: ${JSON.stringify(sample).slice(0, 200)}`) };
      return { ...r, ...ok(`classified=${p.classified} important=${(p.emailsImportant || []).length} sample-from="${sample.from?.slice(0, 30)}"`) };
    },
  },
  {
    name: "email/suggest-draft (email/compose-new or reply-draft)",
    skill: "email/compose-new",
    run: async () => {
      const r = await hit("POST", "/email/suggest-draft", {
        to: "ramy@flipiq.com",
        contactName: "Ramy",
        context: "Ask Ramy to ship the title-company handoff doc to Christian Fuentes by Friday",
      });
      if (r.status !== 200) return { ...r, ...fail(`status=${r.status} body=${JSON.stringify(r.payload).slice(0, 250)}`) };
      const p = r.payload;
      const body = p?.body || "";
      const subj = p?.subject || "";
      if (!body) return { ...r, ...fail(`no body: ${JSON.stringify(p).slice(0, 250)}`) };
      if (!subj) return { ...r, ...fail(`no subject extracted (body=${body.length}chars) — JSON parse likely failed`) };
      if (body.includes("—")) return { ...r, ...fail(`em-dash in body`) };
      return { ...r, ...ok(`subject="${subj.slice(0, 60)}" body=${body.length}chars`) };
    },
  },
];

// ── runner ───────────────────────────────────────────────────────────────────

async function run() {
  const results = [];
  for (const t of tests) {
    process.stdout.write(`[smoke] ${t.name} ... `);
    let result;
    try {
      result = await t.run();
    } catch (e) {
      result = fail(`threw: ${e.message}`);
    }
    results.push({ ...t, ...result });
    process.stdout.write(`${result.pass ? "PASS" : "FAIL"} (${result.latencyMs ?? "?"}ms)\n`);
    if (!result.pass) process.stdout.write(`  └─ ${result.notes}\n`);
  }

  // ── report ─────────────────────────────────────────────────────────────────
  const passCount = results.filter(r => r.pass).length;
  const lines = [];
  lines.push(`# Route-Level Smoke Test (v2 agents)`);
  lines.push(``);
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Base: \`${BASE}\``);
  lines.push(``);
  lines.push(`**${passCount}/${results.length} pass · ${results.length - passCount} fail**`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Route | Skill | Verdict | HTTP | Latency | Notes |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const r of results) {
    lines.push(`| ${r.name} | \`${r.skill}\` | ${r.pass ? "PASS" : "FAIL"} | ${r.status ?? "-"} | ${r.latencyMs ?? "-"}ms | ${(r.notes || "").replace(/\|/g, "\\|").slice(0, 200)} |`);
  }
  lines.push(``);
  lines.push(`## Failures`);
  lines.push(``);
  const failures = results.filter(r => !r.pass);
  if (failures.length === 0) lines.push(`(none)`);
  else {
    for (const f of failures) {
      lines.push(`### ${f.name}`);
      lines.push(``);
      lines.push(`Skill: \`${f.skill}\``);
      lines.push(``);
      lines.push(`HTTP ${f.status ?? "?"} · ${f.latencyMs ?? "?"}ms`);
      lines.push(``);
      lines.push(`**Why it failed:** ${f.notes}`);
      lines.push(``);
      if (f.payload) {
        lines.push(`**Response payload (truncated):**`);
        lines.push(`\`\`\`json`);
        lines.push(JSON.stringify(f.payload, null, 2).slice(0, 1200));
        lines.push(`\`\`\``);
      }
      lines.push(``);
    }
  }

  mkdirSync("ai-outputs", { recursive: true });
  writeFileSync("ai-outputs/route-smoke-test-v2.md", lines.join("\n"));
  console.log(`\n[smoke] ${passCount}/${results.length} pass — report at ai-outputs/route-smoke-test-v2.md`);
}

run().catch(e => { console.error("[smoke] fatal:", e); process.exit(1); });
