// /api/agents/* — settings dashboard backend.
// Phase 0: training-state + start training run + minimal proposals list.
// Phase 6 will flesh this out with memory edit, run history, full dashboard.

import { Router, type IRouter } from "express";
import { z } from "zod";
import { personalDb, agentTrainingRunsTable, agentMemoryProposalsTable, agentFeedbackTable, agentSkillsTable, agentMemoryEntriesTable, agentRunsTable } from "@workspace/db";
import { and, eq, desc, isNull, sql, inArray, asc } from "drizzle-orm";
import { getTrainingState, applyApprovedProposal, rejectProposal } from "../../agents/proposals.js";
import { analyzeFeedback } from "../../agents/coach.js";
import { snapshotFlags } from "../../agents/flags.js";

const router: IRouter = Router();

// ── List specialists (sidebar) ───────────────────────────────────────────────
router.get("/agents", async (_req, res): Promise<void> => {
  // Distinct agents from agent_skills + flag state
  const rows = await personalDb.selectDistinct({ agent: agentSkillsTable.agent }).from(agentSkillsTable);
  const flags = snapshotFlags();
  res.json({
    agents: rows.map(r => ({
      name: r.agent,
      runtime_enabled: flags[`AGENT_RUNTIME_${r.agent.toUpperCase()}`] === true,
    })),
    feedback_pipeline_enabled: flags.FEEDBACK_PIPELINE_ENABLED === true,
  });
});

// ── Training state for one agent (drives Train button + badge) ───────────────
router.get("/agents/:agent/training-state", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  if (!agent) { res.status(400).json({ error: "agent required" }); return; }
  const state = await getTrainingState(agent);
  res.json(state);
});

// ── Start a training run (Train button) ──────────────────────────────────────
const StartBody = z.object({
  feedback_ids: z.array(z.string()).min(1),
  started_by: z.string().email().optional(),
});

router.post("/agents/:agent/training/start", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  if (!agent) { res.status(400).json({ error: "agent required" }); return; }
  const parsed = StartBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Pre-check: any running run for this agent? (TTL sweeper would mark stuck runs failed — Phase 1)
  const [running] = await personalDb.select({ id: agentTrainingRunsTable.id })
    .from(agentTrainingRunsTable)
    .where(and(eq(agentTrainingRunsTable.agent, agent), eq(agentTrainingRunsTable.status, "running")))
    .limit(1);
  if (running) {
    res.status(409).json({ error: "Training already running for this agent", run_id: running.id });
    return;
  }

  // Validate feedback ids belong to this agent + are unconsumed
  const fbRows = await personalDb.select({ id: agentFeedbackTable.id })
    .from(agentFeedbackTable)
    .where(and(
      eq(agentFeedbackTable.agent, agent),
      inArray(agentFeedbackTable.id, parsed.data.feedback_ids),
      isNull(agentFeedbackTable.consumedAt),
    ));
  if (fbRows.length !== parsed.data.feedback_ids.length) {
    res.status(400).json({ error: "Some feedback_ids invalid, already consumed, or wrong agent" });
    return;
  }

  // Create the run row first (status=running) so the Train button locks immediately.
  const [run] = await personalDb.insert(agentTrainingRunsTable).values({
    agent,
    startedBy: parsed.data.started_by || "unknown",
    status: "running",
    feedbackIds: parsed.data.feedback_ids,
  }).returning({ id: agentTrainingRunsTable.id });

  // Fire Coach (Phase 0 stub — marks no_proposal).
  // Don't await — let it run in the background; client polls /training-state.
  analyzeFeedback({
    trainingRunId: run.id,
    agent,
    feedbackIds: parsed.data.feedback_ids,
  }).catch(err => {
    console.error(`[agents-api] Coach failed for run ${run.id}:`, err);
    personalDb.update(agentTrainingRunsTable).set({
      status: "failed",
      finishedAt: new Date(),
      failureReason: err instanceof Error ? err.message : String(err),
    }).where(eq(agentTrainingRunsTable.id, run.id)).catch(() => { /* swallow */ });
  });

  res.json({ ok: true, run_id: run.id });
});

// ── List unconsumed feedback for the Train modal ─────────────────────────────
router.get("/agents/:agent/feedback", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  if (!agent) { res.status(400).json({ error: "agent required" }); return; }
  const showConsumed = req.query.consumed === "true";

  const rows = await personalDb.select().from(agentFeedbackTable)
    .where(showConsumed
      ? eq(agentFeedbackTable.agent, agent)
      : and(eq(agentFeedbackTable.agent, agent), isNull(agentFeedbackTable.consumedAt))!)
    .orderBy(desc(agentFeedbackTable.createdAt))
    .limit(100);

  res.json({ feedback: rows });
});

// ── List proposals ───────────────────────────────────────────────────────────
router.get("/agents/:agent/proposals", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  if (!agent) { res.status(400).json({ error: "agent required" }); return; }
  const status = (req.query.status as string) || "pending";

  const rows = await personalDb.select().from(agentMemoryProposalsTable)
    .where(and(eq(agentMemoryProposalsTable.agent, agent), eq(agentMemoryProposalsTable.status, status)))
    .orderBy(desc(agentMemoryProposalsTable.createdAt))
    .limit(50);

  res.json({ proposals: rows });
});

// ── Approve / reject a proposal ──────────────────────────────────────────────
const DecisionBody = z.object({
  decided_by: z.string().email().optional(),
  rejection_reason: z.string().optional(),
});

router.post("/proposals/:proposalId/approve", async (req, res): Promise<void> => {
  const id = req.params.proposalId;
  if (!id) { res.status(400).json({ error: "proposalId required" }); return; }
  const parsed = DecisionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  try {
    await applyApprovedProposal(id, parsed.data.decided_by || "You");
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/proposals/:proposalId/reject", async (req, res): Promise<void> => {
  const id = req.params.proposalId;
  if (!id) { res.status(400).json({ error: "proposalId required" }); return; }
  const parsed = DecisionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  await rejectProposal(id, parsed.data.decided_by || "You", parsed.data.rejection_reason);
  res.json({ ok: true });
});

// ── Memory inspection (read-only Phase 0; edit lands Phase 6) ────────────────
router.get("/agents/:agent/memory", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  if (!agent) { res.status(400).json({ error: "agent required" }); return; }

  const rows = await personalDb.select({
    kind: agentMemoryEntriesTable.kind,
    section_name: agentMemoryEntriesTable.sectionName,
    version: agentMemoryEntriesTable.version,
    updated_at: agentMemoryEntriesTable.updatedAt,
    updated_by: agentMemoryEntriesTable.updatedBy,
  }).from(agentMemoryEntriesTable)
    .where(eq(agentMemoryEntriesTable.agent, agent))
    .orderBy(agentMemoryEntriesTable.kind, agentMemoryEntriesTable.sectionName);

  res.json({ entries: rows });
});

router.get("/agents/:agent/memory/:section", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  const section = req.params.section;
  if (!agent || !section) { res.status(400).json({ error: "agent + section required" }); return; }
  const kind = (req.query.kind as string) || "memory";

  const [row] = await personalDb.select().from(agentMemoryEntriesTable)
    .where(and(
      eq(agentMemoryEntriesTable.agent, agent),
      eq(agentMemoryEntriesTable.kind, kind),
      eq(agentMemoryEntriesTable.sectionName, section),
    )).limit(1);

  if (!row) { res.status(404).json({ error: "not found" }); return; }
  res.json(row);
});

// ── Edit a memory entry (write-gated to kind='memory' per D5) ────────────────
const MemoryWriteBody = z.object({
  content: z.string(),
  updated_by: z.string().optional(),
});

router.put("/agents/:agent/memory/:section", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  const section = req.params.section;
  if (!agent || !section) { res.status(400).json({ error: "agent + section required" }); return; }

  const parsed = MemoryWriteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const kind = (req.query.kind as string) || "memory";

  // D5: outside of approved Coach proposals, only kind='memory' and kind='soul'
  // are writable through this endpoint. Soul edits require a UI disclaimer
  // acknowledgement. All other identity-tier kinds stay developer-locked
  // (changes flow through git + the seed script).
  if (kind !== "memory" && kind !== "soul") {
    res.status(403).json({
      error: `kind='${kind}' is git-locked — only kind='memory' and kind='soul' can be edited via this endpoint`,
    });
    return;
  }

  const updatedBy = parsed.data.updated_by || "tony";

  const [existing] = await personalDb.select().from(agentMemoryEntriesTable)
    .where(and(
      eq(agentMemoryEntriesTable.agent, agent),
      eq(agentMemoryEntriesTable.kind, kind),
      eq(agentMemoryEntriesTable.sectionName, section),
    )).limit(1);

  if (existing) {
    await personalDb.update(agentMemoryEntriesTable).set({
      content: parsed.data.content,
      version: sql`${agentMemoryEntriesTable.version} + 1`,
      updatedAt: new Date(),
      updatedBy,
    }).where(eq(agentMemoryEntriesTable.id, existing.id));
  } else {
    await personalDb.insert(agentMemoryEntriesTable).values({
      agent,
      kind,
      sectionName: section,
      content: parsed.data.content,
      updatedBy,
    });
  }

  res.json({ ok: true });
});

// ── Run history per agent (Phase 6 dashboard table) ─────────────────────────
router.get("/agents/:agent/runs", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  if (!agent) { res.status(400).json({ error: "agent required" }); return; }

  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10) || 50, 500);
  const skill = req.query.skill as string | undefined;

  const where = skill
    ? and(eq(agentRunsTable.agent, agent), eq(agentRunsTable.skill, skill))!
    : eq(agentRunsTable.agent, agent);

  const rows = await personalDb.select().from(agentRunsTable)
    .where(where)
    .orderBy(desc(agentRunsTable.createdAt))
    .limit(limit);

  res.json({ runs: rows });
});

// ── Skill registry per agent (read-only Phase 6; model_override edit later) ──
router.get("/agents/:agent/skills", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  if (!agent) { res.status(400).json({ error: "agent required" }); return; }

  const rows = await personalDb.select().from(agentSkillsTable)
    .where(eq(agentSkillsTable.agent, agent))
    .orderBy(asc(agentSkillsTable.skillName));

  // Redact the encrypted api_key_cipher blob — the UI only needs to know
  // whether one is configured, not the ciphertext itself. Expose a boolean.
  const skills = rows.map((r) => {
    const cipher = (r as { apiKeyCipher?: string | null }).apiKeyCipher ?? null;
    const baseUrl = (r as { baseUrl?: string | null }).baseUrl ?? null;
    const { apiKeyCipher: _omit, ...rest } = r as typeof r & { apiKeyCipher?: string | null };
    return { ...rest, apiKeyConfigured: Boolean(cipher), baseUrl };
  });

  res.json({ skills });
});

const SkillOverrideBody = z.object({
  model_override: z.string().nullable(),
  // Optional: pin the override to a specific provider. Without this, the
  // override resolves under whatever provider the tier currently maps to.
  provider_override: z.enum(["anthropic", "openai", "google", "openrouter"]).nullable().optional(),
  // Optional: per-skill API key (first-class — when set, skill-level wins over
  // tier-level). Pass empty string to clear; null also clears; undefined leaves
  // unchanged. A non-empty string is encrypted with the same AES-256-GCM helper
  // used by ai_provider_settings (encryptKeyToString → packed iv:tag:cipher b64).
  api_key: z.string().nullable().optional(),
  // Optional: per-skill base URL (e.g. self-hosted OpenRouter proxy). Same
  // null/undefined semantics as api_key.
  base_url: z.string().nullable().optional(),
});

router.put("/agents/:agent/skills/:skill/model-override", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  const skillName = req.params.skill;
  if (!agent || !skillName) { res.status(400).json({ error: "agent + skill required" }); return; }

  const parsed = SkillOverrideBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const updates: Partial<typeof agentSkillsTable.$inferInsert> = {
    modelOverride: parsed.data.model_override,
    updatedAt: new Date(),
  };
  if (parsed.data.provider_override !== undefined) {
    updates.providerOverride = parsed.data.provider_override;
  }
  if (parsed.data.base_url !== undefined) {
    updates.baseUrl = parsed.data.base_url || null;
  }
  if (parsed.data.api_key !== undefined) {
    if (parsed.data.api_key === null || parsed.data.api_key === "") {
      updates.apiKeyCipher = null;
    } else {
      try {
        const { encryptKeyToString } = await import("@workspace/integrations-anthropic-ai");
        updates.apiKeyCipher = encryptKeyToString(parsed.data.api_key);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
  }

  await personalDb.update(agentSkillsTable)
    .set(updates)
    .where(and(eq(agentSkillsTable.agent, agent), eq(agentSkillsTable.skillName, skillName)));

  res.json({ ok: true });
});

// ── Per-skill connectivity test ─────────────────────────────────────────────
// Mirrors POST /ai-settings/:tier/test but scoped to one skill row. If api_key
// is omitted in the body, falls back to the skill's saved api_key_cipher
// (decrypts and uses it).
const SkillTestBody = z.object({
  provider: z.enum(["anthropic", "openai", "google", "openrouter"]),
  model: z.string().min(1),
  api_key: z.string().min(1).optional(),
  base_url: z.string().nullable().optional(),
});

router.post("/agents/:agent/skills/:skill/test-connection", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  const skillName = req.params.skill;
  if (!agent || !skillName) { res.status(400).json({ error: "agent + skill required" }); return; }

  const parsed = SkillTestBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  let apiKey = parsed.data.api_key;
  if (!apiKey) {
    // Use the skill's saved key — decrypt agent_skills.api_key_cipher.
    const [row] = await personalDb.select().from(agentSkillsTable)
      .where(and(eq(agentSkillsTable.agent, agent), eq(agentSkillsTable.skillName, skillName)))
      .limit(1);
    const cipher = (row as { apiKeyCipher?: string | null } | undefined)?.apiKeyCipher;
    if (!cipher) {
      res.status(400).json({
        ok: false,
        error: "No saved skill API key; provide api_key in the body or save one first.",
      });
      return;
    }
    try {
      const { decryptKeyFromString } = await import("@workspace/integrations-anthropic-ai");
      apiKey = decryptKeyFromString(cipher);
    } catch (err) {
      res.status(500).json({ ok: false, error: `Decrypt failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
  }

  try {
    const { testProvider } = await import("@workspace/integrations-anthropic-ai");
    const t0 = Date.now();
    const result = await testProvider(parsed.data.provider, parsed.data.model, apiKey, {
      baseUrl: parsed.data.base_url ?? undefined,
    });
    res.json({
      ok: true,
      provider: parsed.data.provider,
      model: parsed.data.model,
      latencyMs: result.durationMs ?? (Date.now() - t0),
      preview: result.preview,
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      provider: parsed.data.provider,
      model: parsed.data.model,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Direct skill invocation (for fixture replay scripts) ─────────────────────
// Lets operator scripts run an agent skill via HTTP without importing the SDK.
// Used by lib/db/scripts/replay-classification-fixture.mjs to measure accuracy
// of the orchestrator's classify skill (R4 fixture gate). Does NOT need any
// AGENT_RUNTIME_<X> flag — this route always uses runAgent directly.
const InvokeBody = z.object({
  user_message: z.string().min(1),
  caller: z.enum(["direct", "orchestrator", "coach", "cron"]).optional(),
});

router.post("/agents/:agent/skills/:skill/invoke", async (req, res): Promise<void> => {
  const agent = req.params.agent;
  const skillName = req.params.skill;
  if (!agent || !skillName) { res.status(400).json({ error: "agent + skill required" }); return; }

  const parsed = InvokeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Lazy import so this file doesn't pull the runtime when only feedback APIs
  // are needed.
  const { runAgent } = await import("../../agents/runtime.js");

  try {
    const result = await runAgent(agent, skillName, {
      userMessage: parsed.data.user_message,
      caller: parsed.data.caller || "direct",
      meta: { invoked_via: "api/agents/skills/invoke" },
    });
    res.json({
      ok: true,
      text: result.text,
      turns: result.turns,
      tool_calls: result.toolCalls,
      run_id: result.runId,
      resolved: result.resolved,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
