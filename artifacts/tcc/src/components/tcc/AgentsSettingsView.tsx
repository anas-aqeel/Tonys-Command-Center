// /settings/agents — Train UI + memory editor + run history (Phase 1 + 6).
// Sidebar lists agents. Detail panel has tabs: Training, Memory, Skills, Runs.

import { useState, useEffect, useCallback } from "react";
import { get, post, put } from "@/lib/api";
import { C, F, FS } from "@/components/tcc/constants";

type DetailTab = "training" | "memory" | "skills" | "runs";

// Agents that have feedback rows actively flowing into agent_feedback today.
// (UI thumbs/buttons OR backend captures from override paths.)
// All others show "Coming Soon" on the Training tab.
//   - email   : EmailsView thumbs → /emails/action
//   - tasks   : BusinessView reorder → /plan/reorder, priority override → /tasks
//   - ideas   : IdeasModal park / override → /ideas/notify-{park,override}
//   - schedule: forced calendar override → /schedule/add (no FE button, BE-only)
const FEEDBACK_ENABLED_AGENTS = new Set(["email", "tasks", "ideas", "schedule"]);

interface MemoryEntry {
  kind: string;
  section_name: string;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

interface SkillEntry {
  agent: string;
  skillName: string;
  model: string;
  tier: string | null;
  maxTokens: number;
  tools: string[];
  memorySections: string[];
  modelOverride: string | null;
  providerOverride: string | null;
  /** True when agent_skills.api_key_cipher is non-null. UI renders the input
   *  with a "saved" placeholder; user types only to replace. */
  apiKeyConfigured: boolean;
  /** Optional per-skill base URL (e.g. self-hosted OpenRouter proxy). */
  baseUrl: string | null;
  updatedAt: string;
}

interface CatalogModelRow {
  provider: SkillProvider;
  modelId: string;
  inputPerM: number;
  outputPerM: number;
  displayName: string | null;
  lastSyncedAt: string;
}

interface SkillTestResponse {
  ok: boolean;
  provider?: SkillProvider;
  model?: string;
  latencyMs?: number;
  preview?: string;
  error?: string;
}

type SkillProvider = "anthropic" | "openai" | "google" | "openrouter";

interface AiTierRow {
  tier: "basic" | "medium" | "complex";
  provider: SkillProvider;
  model: string;
}
interface AiSettingsResp {
  tiers: AiTierRow[];
  providers: SkillProvider[];
}

interface RunEntry {
  id: string;
  agent: string;
  skill: string;
  caller: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  durationMs: number | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
}

interface AgentEntry { name: string; runtime_enabled: boolean; }
interface AgentsList { agents: AgentEntry[]; feedback_pipeline_enabled: boolean; }

interface TrainingState {
  is_running: boolean;
  run_id: string | null;
  started_at: string | null;
  unconsumed_count: number;
  pending_proposals_count: number;
}

interface FeedbackRow {
  id: string;
  agent: string;
  skill: string;
  sourceType: string;
  sourceId: string;
  rating: number | null;
  reviewText: string | null;
  contextSnapshot: Record<string, unknown>;
  consumedAt: string | null;
  createdAt: string;
}

interface MemoryDiff {
  section_name: string;
  kind: string;
  before: string;
  after: string;
}
interface ProposalRow {
  id: string;
  agent: string;
  trainingRunId: string;
  reason: string;
  diffs: MemoryDiff[];
  feedbackIds: string[];
  status: string;
  rejectionReason: string | null;
  createdAt: string;
}

// Hint left in sessionStorage by feedback surfaces (EmailsView thumbs, etc.)
// when the user clicks "Train now" in a toast. Picked up here on mount so we
// can open the right agent + pre-select the row.
interface PendingTrainHint {
  agent: string;
  feedbackId: string | null;
  sourceId: string | null;
  ts: number;
}

function readPendingTrainHint(): PendingTrainHint | null {
  try {
    const raw = sessionStorage.getItem("tcc_pending_train");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingTrainHint;
    // 5-min freshness gate — if Tony left the tab open and clicks the toast
    // action much later, the hint is stale and we'd surprise him.
    if (Date.now() - parsed.ts > 5 * 60 * 1000) {
      sessionStorage.removeItem("tcc_pending_train");
      return null;
    }
    return parsed;
  } catch { return null; }
}

export function AgentsSettingsView({ onBack }: { onBack: () => void }) {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [pipelineEnabled, setPipelineEnabled] = useState(false);
  const [pipelineLoading, setPipelineLoading] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [pendingHint, setPendingHint] = useState<PendingTrainHint | null>(() => readPendingTrainHint());

  useEffect(() => {
    get<AgentsList>("/agents")
      .then(d => {
        setAgents(d.agents);
        setPipelineEnabled(d.feedback_pipeline_enabled);
        if (d.agents.length > 0 && !selectedAgent) {
          // If a "Train now" hint pointed us at a specific agent, open that
          // tab — otherwise default to the first one in the registry.
          const target = pendingHint && d.agents.find(a => a.name === pendingHint.agent)
            ? pendingHint.agent
            : d.agents[0].name;
          setSelectedAgent(target);
        }
      })
      .catch(console.error)
      .finally(() => {
        setPipelineLoading(false);
        setAgentsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the AgentDetail consumes the hint (auto-select + scroll), it calls
  // back to clear it so a re-render or sidebar click doesn't re-trigger.
  const consumeHint = () => {
    setPendingHint(null);
    try { sessionStorage.removeItem("tcc_pending_train"); } catch { /**/ }
  };

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 24px", fontFamily: F }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: C.sub, fontSize: 14 }}>← Back</button>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.tx, margin: 0, fontFamily: FS }}>Agent Training</h1>
        <span style={{
          marginLeft: "auto", fontSize: 11, padding: "4px 10px", borderRadius: 999,
          background: pipelineLoading ? "#F3F4F6" : pipelineEnabled ? C.grnBg : C.redBg,
          color: pipelineLoading ? C.mut : pipelineEnabled ? C.grn : C.red,
          fontWeight: 700,
        }}>
          {pipelineLoading
            ? "Loading pipeline status…"
            : pipelineEnabled
              ? "Feedback pipeline ON"
              : "Feedback pipeline OFF (no rows being captured)"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 16 }}>
        {/* Sidebar */}
        <div style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 10, overflow: "hidden" }}>
          {agents.map(a => (
            <button
              key={a.name}
              onClick={() => setSelectedAgent(a.name)}
              style={{
                display: "block", width: "100%", padding: "10px 14px",
                textAlign: "left", border: "none", cursor: "pointer", fontFamily: F, fontSize: 13,
                background: selectedAgent === a.name ? C.bluBg : "transparent",
                color: selectedAgent === a.name ? C.blu : C.tx,
                fontWeight: selectedAgent === a.name ? 700 : 500,
                borderBottom: `1px solid ${C.brd}`,
              }}
            >
              <span style={{ textTransform: "capitalize" }}>{a.name}</span>
              {a.runtime_enabled && (
                <span style={{
                  fontSize: 9, marginLeft: 6, padding: "2px 6px",
                  background: C.grnBg, color: C.grn, borderRadius: 4, fontWeight: 700,
                }}>LIVE</span>
              )}
            </button>
          ))}
          {agents.length === 0 && agentsLoading && (
            [0, 1, 2, 3].map(i => (
              <div key={i} style={{ padding: "10px 14px", borderBottom: `1px solid ${C.brd}` }}>
                <div style={{ width: "60%", height: 10, background: "#EEE", borderRadius: 3 }} />
              </div>
            ))
          )}
          {agents.length === 0 && !agentsLoading && (
            <div style={{ padding: 16, fontSize: 12, color: C.mut }}>No agents found in registry.</div>
          )}
        </div>

        {/* Detail */}
        <div>
          {selectedAgent
            ? <AgentDetail
                agent={selectedAgent}
                pipelineEnabled={pipelineEnabled}
                pendingHint={pendingHint && pendingHint.agent === selectedAgent ? pendingHint : null}
                onHintConsumed={consumeHint}
              />
            : agentsLoading
              ? <div style={{ padding: 24, color: C.mut }}>Loading agents…</div>
              : <div style={{ padding: 24, color: C.mut }}>Pick an agent from the sidebar.</div>}
        </div>
      </div>
    </div>
  );
}

function AgentDetail({ agent, pipelineEnabled, pendingHint, onHintConsumed }: {
  agent: string;
  pipelineEnabled: boolean;
  pendingHint: PendingTrainHint | null;
  onHintConsumed: () => void;
}) {
  const [state, setState] = useState<TrainingState | null>(null);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [training, setTraining] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [error, setError] = useState<string>("");
  // Pre-train disclaimer modal: when Tony has 1 row selected but >1 unconsumed
  // exist, surface a one-question modal nudging him to either include them all
  // (one Coach run, cost-saving) or proceed with just the selected row.
  const [confirmTrain, setConfirmTrain] = useState<{ selectedCount: number; allUnconsumedIds: string[] } | null>(null);
  const [hintBanner, setHintBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, f, p] = await Promise.all([
        get<TrainingState>(`/agents/${agent}/training-state`),
        get<{ feedback: FeedbackRow[] }>(`/agents/${agent}/feedback`),
        get<{ proposals: ProposalRow[] }>(`/agents/${agent}/proposals?status=pending`),
      ]);
      setState(s);
      setFeedback(f.feedback);
      setProposals(p.proposals);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [agent]);

  // Refresh on load + on agent switch. No polling.
  useEffect(() => {
    refresh();
    setSelected(new Set());
  }, [agent, refresh]);

  // Consume the "Train now"-toast hint once feedback rows are loaded for this
  // agent. Match strategy: feedback_id (exact) → source_id fallback. Newest
  // matching row wins (feedback list is ordered desc by createdAt).
  useEffect(() => {
    if (!pendingHint || feedback.length === 0) return;
    const match = pendingHint.feedbackId
      ? feedback.find(f => f.id === pendingHint.feedbackId)
      : pendingHint.sourceId
        ? feedback.find(f => (f as { sourceId?: string; source_id?: string }).sourceId === pendingHint.sourceId || (f as { source_id?: string }).source_id === pendingHint.sourceId)
        : null;
    if (match) {
      setSelected(new Set([match.id]));
      setHintBanner(`Pre-selected the ${pendingHint.agent} feedback you just submitted — review and click Train.`);
    } else {
      setHintBanner(`Couldn't find that feedback in the list — it may already be consumed. Pick rows manually.`);
    }
    onHintConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHint, feedback]);

  const toggle = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };
  const selectAll = () => setSelected(new Set(feedback.map(f => f.id)));
  const clearAll = () => setSelected(new Set());

  // The actual training-start fetch. Split out so the disclaimer modal can
  // call it directly with whichever id-set Tony chose ("just selected" vs
  // "all unconsumed").
  const fireTraining = async (ids: string[]) => {
    if (ids.length === 0) return;
    setTraining(true);
    setError("");
    try {
      await post("/agents/" + agent + "/training/start", { feedback_ids: ids });
      setSelected(new Set());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTraining(false);
    }
  };

  const startTraining = () => {
    if (selected.size === 0) return;
    // Cost-saving nudge: if Tony has just 1 row selected but more unconsumed
    // rows exist for this agent, ONE Coach run can chew through all of them.
    // Show the modal so he picks "all available" (cheaper) or "just selected".
    const allUnconsumed = feedback.filter(f => {
      const consumed = (f as { consumedAt?: string | null; consumed_at?: string | null }).consumedAt
        ?? (f as { consumed_at?: string | null }).consumed_at;
      return consumed == null;
    }).map(f => f.id);
    if (selected.size === 1 && allUnconsumed.length > 1) {
      setConfirmTrain({ selectedCount: selected.size, allUnconsumedIds: allUnconsumed });
      return;
    }
    fireTraining(Array.from(selected));
  };

  const decide = async (proposalId: string, action: "approve" | "reject", reason?: string) => {
    try {
      await post(`/proposals/${proposalId}/${action}`, action === "reject" ? { rejection_reason: reason } : {});
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const [tab, setTab] = useState<DetailTab>("training");

  if (!state) {
    return (
      <div>
        <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: `1px solid ${C.brd}` }}>
          {(["training", "memory", "skills", "runs"] as DetailTab[]).map(t => (
            <div key={t} style={{ padding: "8px 14px", fontSize: 13, color: C.mut, textTransform: "capitalize" }}>{t}</div>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 14 }}>
              <div style={{ width: "40%", height: 12, background: "#EEE", borderRadius: 4, marginBottom: 10 }} />
              <div style={{ width: "75%", height: 10, background: "#F2F2F2", borderRadius: 4, marginBottom: 6 }} />
              <div style={{ width: "60%", height: 10, background: "#F2F2F2", borderRadius: 4 }} />
            </div>
          ))}
          <div style={{ fontSize: 12, color: C.mut, fontStyle: "italic", padding: "8px 4px" }}>Loading {agent}…</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Hint banner — surfaces when AgentDetail mounted from a "Train now"
          toast click. Tells Tony which row was pre-selected (or that we
          couldn't find it) so the auto-select isn't surprising. */}
      {hintBanner && (
        <div style={{
          background: C.bluBg, border: `1px solid ${C.blu}`, borderRadius: 8,
          padding: "10px 14px", marginBottom: 12, fontSize: 13, color: C.blu,
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{ fontSize: 16 }}>💡</span>
          <span style={{ flex: 1 }}>{hintBanner}</span>
          <button onClick={() => setHintBanner(null)} style={{
            background: "transparent", border: "none", color: C.blu, cursor: "pointer",
            fontSize: 16, padding: 0, lineHeight: 1,
          }}>✕</button>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: `1px solid ${C.brd}` }}>
        {(["training", "memory", "skills", "runs"] as DetailTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 14px", fontSize: 13, fontWeight: 600,
              border: "none", background: "transparent", cursor: "pointer", fontFamily: F,
              color: tab === t ? C.blu : C.sub,
              borderBottom: tab === t ? `2px solid ${C.blu}` : "2px solid transparent",
              textTransform: "capitalize",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Pre-train cost-saving disclaimer modal */}
      {confirmTrain && (
        <div
          onClick={() => setConfirmTrain(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 12, padding: 24, maxWidth: 480, width: "92%" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.tx, marginBottom: 8, fontFamily: FS }}>
              Train on all available feedback?
            </div>
            <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.5, marginBottom: 18 }}>
              You selected <strong>1 feedback</strong>, but there are <strong>{confirmTrain.allUnconsumedIds.length - 1}</strong> more unconsumed rows for <strong style={{ textTransform: "capitalize" }}>{agent}</strong>. Training all together is <strong>one Coach run</strong> instead of {confirmTrain.allUnconsumedIds.length} — saves cost, and Coach finds patterns across the batch instead of treating each in isolation.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                onClick={() => { const ids = confirmTrain.allUnconsumedIds; setConfirmTrain(null); fireTraining(ids); }}
                style={{ ...btn1, background: C.grn, width: "100%", padding: "10px 14px", fontSize: 13 }}
              >
                Continue with all {confirmTrain.allUnconsumedIds.length} available feedback
              </button>
              <button
                onClick={() => { const ids = Array.from(selected); setConfirmTrain(null); fireTraining(ids); }}
                style={{ ...btnGhost, width: "100%", padding: "10px 14px", fontSize: 13 }}
              >
                Continue anyway (just the 1 I selected)
              </button>
              <button
                onClick={() => setConfirmTrain(null)}
                style={{ background: "transparent", border: "none", color: C.mut, fontSize: 12, fontFamily: F, cursor: "pointer", padding: "6px 0", marginTop: 4 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "memory" && <MemoryTab agent={agent} />}
      {tab === "skills" && <SkillsTab agent={agent} />}
      {tab === "runs" && <RunsTab agent={agent} />}
      {tab === "training" && <TrainingTabContent
        state={state} feedback={feedback} proposals={proposals}
        selected={selected} training={training} refreshing={refreshing}
        lastRefreshed={lastRefreshed} error={error} pipelineEnabled={pipelineEnabled}
        agent={agent}
        onRefresh={refresh}
        onToggle={toggle} onSelectAll={selectAll} onClearAll={clearAll}
        onStartTraining={startTraining} onDecide={decide}
      />}
    </div>
  );
}

interface TrainingTabProps {
  state: TrainingState; feedback: FeedbackRow[]; proposals: ProposalRow[];
  selected: Set<string>; training: boolean; refreshing: boolean;
  lastRefreshed: Date | null; error: string; pipelineEnabled: boolean;
  agent: string;
  onRefresh: () => void;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onStartTraining: () => void;
  onDecide: (id: string, action: "approve" | "reject", reason?: string) => void;
}

function TrainingTabContent(props: TrainingTabProps) {
  const { agent, state, feedback, proposals, selected, training, refreshing, lastRefreshed, error, pipelineEnabled, onRefresh, onToggle, onSelectAll, onClearAll, onStartTraining, onDecide } = props;

  if (!FEEDBACK_ENABLED_AGENTS.has(agent)) {
    return (
      <div style={{ padding: "48px 24px", textAlign: "center", background: C.card, borderRadius: 12, border: `1px solid ${C.brd}` }}>
        <div style={{ fontSize: 36, marginBottom: 14 }}>🔜</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: C.tx, marginBottom: 10, fontFamily: FS }}>Coming Soon</div>
        <div style={{ fontSize: 13, color: C.mut, maxWidth: 380, margin: "0 auto", lineHeight: 1.7 }}>
          Feedback collection for <strong style={{ color: C.tx, textTransform: "capitalize" }}>{agent}</strong> isn't wired to the UI yet.
          Once feedback buttons are added in the relevant view, this training queue will become active.
        </div>
        <div style={{ marginTop: 20, fontSize: 12, color: C.sub, padding: "8px 14px", background: C.bg, borderRadius: 8, display: "inline-block" }}>
          Active feedback: <strong>email · tasks · ideas · schedule</strong>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Refresh row */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: C.mut }}>
          {lastRefreshed ? `Last refreshed ${lastRefreshed.toLocaleTimeString()}` : ""}
        </span>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          style={{
            ...btnGhost,
            marginLeft: "auto",
            opacity: refreshing ? 0.6 : 1,
            cursor: refreshing ? "default" : "pointer",
          }}
          title="Refetch training state, feedback queue, and pending proposals"
        >
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      {/* Status row */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Card label="Unconsumed feedback" value={String(state.unconsumed_count)} color={state.unconsumed_count > 0 ? C.amb : C.mut} />
        <Card label="Pending proposals" value={String(state.pending_proposals_count)} color={state.pending_proposals_count > 0 ? C.blu : C.mut} />
        <Card label="Training run" value={state.is_running ? "RUNNING" : "idle"} color={state.is_running ? C.grn : C.mut} />
      </div>


      {state.is_running && (
        <div style={{ background: C.grnBg, color: C.grn, padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          Coach is analyzing this batch. Click <b>↻ Refresh</b> after a moment to see the result.
        </div>
      )}

      {error && (
        <div style={{ background: C.redBg, color: C.red, padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {!pipelineEnabled && (
        <div style={{ background: C.ambBg, color: C.amb, padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          ⚠️ Feedback pipeline is OFF. Set <code>FEEDBACK_PIPELINE_ENABLED=true</code> in env to start capturing rows.
        </div>
      )}

      {/* Pending proposals — top of page */}
      {proposals.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: C.tx, marginBottom: 10, fontFamily: FS }}>Pending proposals</h2>
          {proposals.map(p => <ProposalCard key={p.id} proposal={p} onDecide={onDecide} />)}
        </div>
      )}

      {/* Feedback queue */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: C.tx, margin: 0, fontFamily: FS }}>Unconsumed feedback ({feedback.length})</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={onSelectAll} style={btnGhost}>Select all</button>
          <button onClick={onClearAll} style={btnGhost}>Clear</button>
          <button
            onClick={onStartTraining}
            disabled={selected.size === 0 || state.is_running || training}
            style={{
              ...btn1,
              background: (selected.size === 0 || state.is_running) ? C.mut : C.blu,
              opacity: training ? 0.6 : 1,
            }}
          >
            {state.is_running ? "Run in progress…" : training ? "Starting…" : `Train (${selected.size})`}
          </button>
        </div>
      </div>

      {feedback.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: C.mut, background: C.card, borderRadius: 8, border: `1px solid ${C.brd}` }}>
          No unconsumed feedback for this agent.
        </div>
      )}

      {feedback.map(f => (
        <FeedbackRowCard key={f.id} row={f} selected={selected.has(f.id)} onToggle={() => onToggle(f.id)} />
      ))}
    </div>
  );
}

// ── Soul disclaimer modal ─────────────────────────────────────────────────────
function SoulDisclaimerModal({ sectionName, onConfirm, onCancel }: { sectionName: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <>
      <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.32)", zIndex: 1100, backdropFilter: "blur(2px)" }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: 460, background: "#FFF", borderRadius: 14, padding: "28px 28px 20px",
        zIndex: 1101, boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 22 }}>&#9888;</span>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#B45309", fontFamily: FS }}>Edit Soul File</h3>
        </div>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: C.tx, margin: "0 0 8px" }}>
          You are about to edit <strong>{sectionName}</strong>.
        </p>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: C.tx, margin: "0 0 16px" }}>
          Soul files define this agent&apos;s core personality, voice, and values.
          Editing these directly can <strong>fundamentally change</strong> how the agent behaves.
          Changes take effect on the next agent run.
        </p>
        <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 12px", marginBottom: 20, fontSize: 12, color: "#92400E", lineHeight: 1.5 }}>
          Tip: For minor behavior tweaks, prefer training via feedback + Coach proposals (Memory sections). Only edit soul files when you want to change the agent&apos;s fundamental character.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={{ padding: "8px 16px", fontSize: 13, fontFamily: F, border: `1px solid ${C.brd}`, borderRadius: 8, background: "#FFF", cursor: "pointer", color: C.tx }}>Cancel</button>
          <button onClick={onConfirm} style={{ padding: "8px 16px", fontSize: 13, fontFamily: F, border: "none", borderRadius: 8, background: "#D97706", color: "#FFF", cursor: "pointer", fontWeight: 600 }}>I understand — Unlock editing</button>
        </div>
      </div>
    </>
  );
}

// ── Memory tab ────────────────────────────────────────────────────────────────
function MemoryTab({ agent }: { agent: string }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [soulEditUnlocked, setSoulEditUnlocked] = useState<Set<string>>(new Set());
  const [showSoulWarning, setShowSoulWarning] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await get<{ entries: MemoryEntry[] }>(`/agents/${agent}/memory`);
      setEntries(r.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agent]);

  useEffect(() => {
    loadList();
    setSelectedSection(null);
    setContent("");
    setOriginalContent("");
    setSoulEditUnlocked(new Set());
  }, [agent, loadList]);

  const loadSection = async (kind: string, section: string) => {
    setLoading(true);
    setError("");
    try {
      const r = await get<{ content: string }>(`/agents/${agent}/memory/${section}?kind=${encodeURIComponent(kind)}`);
      setContent(r.content);
      setOriginalContent(r.content);
      setSelectedSection(`${kind}/${section}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!selectedSection) return;
    const [kind, section] = selectedSection.split("/");
    setSaving(true);
    setError("");
    try {
      await put(`/agents/${agent}/memory/${section}?kind=${encodeURIComponent(kind)}`, { content, updated_by: "tony" });
      setOriginalContent(content);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleUnlockSoul = () => {
    if (!selectedSection) return;
    setSoulEditUnlocked(prev => new Set(prev).add(selectedSection));
    setShowSoulWarning(false);
  };

  const memoryEntries = entries.filter(e => e.kind === "memory");
  const soulEntries = entries.filter(e => e.kind === "soul");
  const systemEntries = entries.filter(e => e.kind !== "memory" && e.kind !== "soul");
  const dirty = content !== originalContent;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
      {/* Soul disclaimer modal */}
      {showSoulWarning && selectedSection && (
        <SoulDisclaimerModal
          sectionName={selectedSection.split("/")[1]}
          onConfirm={handleUnlockSoul}
          onCancel={() => setShowSoulWarning(false)}
        />
      )}

      {/* Section list */}
      <div style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 10, overflow: "hidden", maxHeight: "70vh", overflowY: "auto" }}>
        <div style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: C.mut, textTransform: "uppercase", background: "#FAFAFA" }}>Memory (editable)</div>
        {loading && entries.length === 0 && (
          [0, 1, 2].map(i => (
            <div key={i} style={{ padding: "8px 12px", borderBottom: `1px solid ${C.brd}` }}>
              <div style={{ width: "65%", height: 10, background: "#EEE", borderRadius: 3 }} />
            </div>
          ))
        )}
        {!loading && memoryEntries.length === 0 && <div style={{ padding: 12, fontSize: 12, color: C.mut }}>None — Coach proposals will populate this.</div>}
        {memoryEntries.map(e => (
          <button
            key={`${e.kind}/${e.section_name}`}
            onClick={() => loadSection(e.kind, e.section_name)}
            style={{
              display: "block", width: "100%", textAlign: "left", border: "none",
              padding: "8px 12px", fontSize: 13, fontFamily: F, cursor: "pointer",
              background: selectedSection === `${e.kind}/${e.section_name}` ? C.bluBg : "transparent",
              color: selectedSection === `${e.kind}/${e.section_name}` ? C.blu : C.tx,
              borderBottom: `1px solid ${C.brd}`,
            }}
          >
            {e.section_name}
            {e.updated_by === "coach" && (
              <span style={{ fontSize: 9, marginLeft: 6, padding: "1px 5px", background: "#F3E5F5", color: "#7B1FA2", borderRadius: 4 }}>COACH</span>
            )}
          </button>
        ))}

        {soulEntries.length > 0 && (
          <>
            <div style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "#92400E", textTransform: "uppercase", background: "#FFFBEB", marginTop: 4 }}>Soul (edit with caution)</div>
            {soulEntries.map(e => (
              <button
                key={`${e.kind}/${e.section_name}`}
                onClick={() => loadSection(e.kind, e.section_name)}
                style={{
                  display: "block", width: "100%", textAlign: "left", border: "none",
                  padding: "8px 12px", fontSize: 13, fontFamily: F, cursor: "pointer",
                  background: selectedSection === `${e.kind}/${e.section_name}` ? "#FEF3C7" : "transparent",
                  color: selectedSection === `${e.kind}/${e.section_name}` ? "#B45309" : C.tx,
                  borderBottom: `1px solid ${C.brd}`,
                }}
              >
                <span style={{ fontSize: 9, marginRight: 6, padding: "1px 5px", background: "#FEF3C7", color: "#B45309", borderRadius: 4, textTransform: "uppercase" }}>SOUL</span>
                {e.section_name}
              </button>
            ))}
          </>
        )}

        <div style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: C.mut, textTransform: "uppercase", background: "#FAFAFA", marginTop: 4 }}>System (read-only)</div>
        {systemEntries.map(e => (
          <button
            key={`${e.kind}/${e.section_name}`}
            onClick={() => loadSection(e.kind, e.section_name)}
            style={{
              display: "block", width: "100%", textAlign: "left", border: "none",
              padding: "8px 12px", fontSize: 13, fontFamily: F, cursor: "pointer",
              background: selectedSection === `${e.kind}/${e.section_name}` ? C.bluBg : "transparent",
              color: C.sub, borderBottom: `1px solid ${C.brd}`,
            }}
          >
            <span style={{ fontSize: 9, marginRight: 6, padding: "1px 5px", background: "#ECEFF1", color: C.mut, borderRadius: 4, textTransform: "uppercase" }}>{e.kind}</span>
            {e.section_name}
          </button>
        ))}
      </div>

      {/* Editor */}
      <div>
        {error && <div style={{ background: C.redBg, color: C.red, padding: 8, borderRadius: 6, marginBottom: 8, fontSize: 12 }}>{error}</div>}
        {!selectedSection && <div style={{ color: C.mut, padding: 24 }}>Pick a section on the left to view or edit.</div>}
        {selectedSection && (() => {
          const [kind] = selectedSection.split("/");
          const isSoul = kind === "soul";
          const isSoulUnlocked = isSoul && soulEditUnlocked.has(selectedSection);
          const readOnly = kind !== "memory" && !isSoulUnlocked;
          return (
            <>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: C.tx, margin: 0, fontFamily: FS }}>{selectedSection}</h3>
                {readOnly && !isSoul && (
                  <span style={{ fontSize: 10, padding: "2px 6px", background: "#ECEFF1", color: C.mut, borderRadius: 4 }}>READ-ONLY</span>
                )}
                {isSoul && !isSoulUnlocked && (
                  <button onClick={() => setShowSoulWarning(true)} style={{ fontSize: 11, padding: "3px 10px", background: "#D97706", color: "#FFF", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: F, fontWeight: 600 }}>
                    Unlock Edit
                  </button>
                )}
                {isSoulUnlocked && (
                  <span style={{ fontSize: 10, padding: "2px 6px", background: "#FEF3C7", color: "#B45309", borderRadius: 4, fontWeight: 600 }}>UNLOCKED</span>
                )}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {dirty && !readOnly && <span style={{ fontSize: 11, color: C.amb }}>Unsaved</span>}
                  {!readOnly && (
                    <button onClick={save} disabled={!dirty || saving} style={{ ...btn1, background: dirty ? (isSoul ? "#D97706" : C.grn) : C.mut, opacity: saving ? 0.6 : 1 }}>
                      {saving ? "Saving…" : "Save"}
                    </button>
                  )}
                </div>
              </div>
              {isSoul && isSoulUnlocked && (
                <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 12px", marginBottom: 8, fontSize: 12, color: "#92400E", lineHeight: 1.4 }}>
                  Editing soul file — changes affect agent personality and take effect on next run.
                </div>
              )}
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                readOnly={readOnly || loading}
                style={{
                  width: "100%", minHeight: 480, padding: 12,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13,
                  border: `1px solid ${isSoulUnlocked ? "#FDE68A" : C.brd}`, borderRadius: 8, resize: "vertical",
                  background: readOnly ? "#FAFAFA" : isSoulUnlocked ? "#FFFBEB" : C.card, color: C.tx,
                }}
              />
            </>
          );
        })()}
      </div>
    </div>
  );
}

// ── Skills tab ────────────────────────────────────────────────────────────────
// Heuristic mirrors lib/integrations-anthropic-ai/src/feature-tiers.ts
// for skills that aren't explicitly mapped (most agent skills default to
// 'complex'). The resolved-model display falls back to this if the skill
// row has no `tier` column populated yet.
function inferTier(skill: SkillEntry): "basic" | "medium" | "complex" {
  if (skill.tier === "basic" || skill.tier === "medium" || skill.tier === "complex") return skill.tier;
  // agent_<x>_<skill> features default to 'complex' in the tier-resolver.
  return "complex";
}

const SKILL_PROVIDERS: SkillProvider[] = ["anthropic", "openai", "google", "openrouter"];

function SkillsTab({ agent }: { agent: string }) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [aiSettings, setAiSettings] = useState<AiSettingsResp | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError("");
    Promise.all([
      get<{ skills: SkillEntry[] }>(`/agents/${agent}/skills`),
      get<AiSettingsResp>("/ai-settings").catch(() => null),
    ])
      .then(([s, ai]) => {
        setSkills(s.skills);
        setAiSettings(ai);
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [agent]);

  const updateOverride = async (
    skillName: string,
    payload: {
      model_override: string | null;
      provider_override: SkillProvider | null;
      api_key?: string | null;
      base_url?: string | null;
    },
  ) => {
    try {
      await put(`/agents/${agent}/skills/${skillName}/model-override`, payload);
      const r = await get<{ skills: SkillEntry[] }>(`/agents/${agent}/skills`);
      setSkills(r.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Map tier → live (provider, model) from AI Settings — used when no override is set.
  const tierMap: Record<string, { provider: SkillProvider; model: string }> = {};
  if (aiSettings) {
    for (const t of aiSettings.tiers) tierMap[t.tier] = { provider: t.provider, model: t.model };
  }

  return (
    <div>
      {error && <div style={{ background: C.redBg, color: C.red, padding: 8, borderRadius: 6, marginBottom: 8, fontSize: 12 }}>{error}</div>}
      {loading && skills.length === 0 && (
        [0, 1, 2].map(i => (
          <div key={i} style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 12, marginBottom: 8 }}>
            <div style={{ width: "30%", height: 12, background: "#EEE", borderRadius: 4, marginBottom: 8 }} />
            <div style={{ width: "55%", height: 10, background: "#F2F2F2", borderRadius: 4 }} />
          </div>
        ))
      )}
      {!loading && skills.length === 0 && <div style={{ color: C.mut, padding: 24 }}>No skills registered.</div>}
      {skills.map(s => {
        const tier = inferTier(s);
        const tierResolved = tierMap[tier];
        const hasOverride = !!s.modelOverride;
        const resolvedModel = hasOverride
          ? s.modelOverride!
          : tierResolved?.model ?? s.model;
        const resolvedProvider = hasOverride
          ? (s.providerOverride as SkillProvider | null) ?? tierResolved?.provider ?? null
          : tierResolved?.provider ?? null;

        return (
          <SkillRow
            key={s.skillName}
            agent={agent}
            skill={s}
            tier={tier}
            resolvedModel={resolvedModel}
            resolvedProvider={resolvedProvider}
            hasOverride={hasOverride}
            onSave={(payload) => updateOverride(s.skillName, payload)}
          />
        );
      })}
    </div>
  );
}

function SkillRow({
  agent,
  skill,
  tier,
  resolvedModel,
  resolvedProvider,
  hasOverride,
  onSave,
}: {
  agent: string;
  skill: SkillEntry;
  tier: "basic" | "medium" | "complex";
  resolvedModel: string;
  resolvedProvider: SkillProvider | null;
  hasOverride: boolean;
  onSave: (payload: {
    model_override: string | null;
    provider_override: SkillProvider | null;
    api_key?: string | null;
    base_url?: string | null;
  }) => void;
}) {
  // Collapsed by default; expand to show the full provider+model+key+test form.
  const [expanded, setExpanded] = useState(false);

  // Form drafts.
  const [modelDraft, setModelDraft] = useState<string>(skill.modelOverride ?? "");
  const [providerDraft, setProviderDraft] = useState<SkillProvider | "">(
    (skill.providerOverride as SkillProvider | null) ?? "",
  );
  const [apiKeyDraft, setApiKeyDraft] = useState<string>("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrlDraft, setBaseUrlDraft] = useState<string>(skill.baseUrl ?? "");

  // Per-row test/save status.
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<SkillTestResponse | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Reset drafts when the skill row updates from the server (post-save reload).
  useEffect(() => {
    setModelDraft(skill.modelOverride ?? "");
    setProviderDraft((skill.providerOverride as SkillProvider | null) ?? "");
    setBaseUrlDraft(skill.baseUrl ?? "");
    setApiKeyDraft("");
  }, [skill.modelOverride, skill.providerOverride, skill.baseUrl, skill.apiKeyConfigured]);

  // Live model catalog for the chosen provider — feeds the model combobox
  // (mirrors ModelSettingsView). Falls back gracefully if the route is
  // unreachable (skill row still works without suggestions).
  const [catalog, setCatalog] = useState<CatalogModelRow[]>([]);
  useEffect(() => {
    if (!expanded || !providerDraft) { setCatalog([]); return; }
    let cancelled = false;
    get<CatalogModelRow[]>(`/ai-settings/models?provider=${providerDraft}`)
      .then((rs) => { if (!cancelled) setCatalog(rs); })
      .catch(() => { if (!cancelled) setCatalog([]); });
    return () => { cancelled = true; };
  }, [expanded, providerDraft]);

  const onTest = async () => {
    if (!providerDraft) {
      setTestResult({ ok: false, error: "Pick a provider first." });
      return;
    }
    if (!modelDraft.trim()) {
      setTestResult({ ok: false, error: "Enter a model id first." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = {
        provider: providerDraft,
        model: modelDraft.trim(),
      };
      if (apiKeyDraft) body.api_key = apiKeyDraft;
      if (baseUrlDraft) body.base_url = baseUrlDraft;
      const res = await post<SkillTestResponse>(
        `/agents/${agent}/skills/${skill.skillName}/test-connection`,
        body,
      );
      setTestResult(res);
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const onSaveClick = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const o = modelDraft.trim() || null;
      const p = o ? (providerDraft || null) : null; // clearing model clears provider too
      const payload: {
        model_override: string | null;
        provider_override: SkillProvider | null;
        api_key?: string | null;
        base_url?: string | null;
      } = {
        model_override: o,
        provider_override: p,
      };
      // api_key: only send when user typed something OR baseUrl draft differs
      // — undefined leaves the saved key untouched.
      if (apiKeyDraft) payload.api_key = apiKeyDraft;
      if ((baseUrlDraft || null) !== (skill.baseUrl || null)) {
        payload.base_url = baseUrlDraft || null;
      }
      onSave(payload);
      setApiKeyDraft("");
      setSaveMsg("Saved.");
      setTimeout(() => setSaveMsg(null), 2200);
    } finally {
      setSaving(false);
    }
  };

  const onClearKey = () => {
    if (!skill.apiKeyConfigured) return;
    onSave({
      model_override: skill.modelOverride,
      provider_override: skill.providerOverride as SkillProvider | null,
      api_key: null,
    });
    setApiKeyDraft("");
  };

  const cardStyle: React.CSSProperties = {
    background: C.card,
    border: `1px solid ${hasOverride || skill.apiKeyConfigured ? "#FCD34D" : C.brd}`,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  };

  return (
    <div style={cardStyle}>
      {/* Header row — always visible */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            background: "transparent", border: "none", cursor: "pointer",
            color: C.sub, fontSize: 12, padding: 0, marginRight: 4,
          }}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▼" : "▶"}
        </button>
        <strong style={{ fontSize: 14, color: C.tx }}>{skill.skillName}</strong>
        <span style={{
          fontSize: 9, padding: "1px 6px", borderRadius: 4,
          background: tier === "basic" ? "#FEF3C7" : tier === "medium" ? C.bluBg : "#F3E5F5",
          color: tier === "basic" ? "#92400E" : tier === "medium" ? C.blu : "#7B1FA2",
          textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.5,
        }}>{tier}</span>
        <span style={{ fontSize: 11, color: C.sub, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
          {resolvedProvider ? `${resolvedProvider} / ` : ""}{resolvedModel}
        </span>
        {hasOverride && (
          <span style={{ fontSize: 9, padding: "1px 5px", background: "#FEF3C7", color: "#92400E", borderRadius: 4, fontWeight: 600 }}>
            OVERRIDE
          </span>
        )}
        {skill.apiKeyConfigured && (
          <span
            style={{ fontSize: 9, padding: "1px 5px", background: C.grnBg, color: C.grn, borderRadius: 4, fontWeight: 600 }}
            title="Skill has its own saved API key (wins over tier key)"
          >
            OWN KEY
          </span>
        )}
        <span style={{ fontSize: 11, color: C.mut }}>
          · {skill.maxTokens} tokens · {skill.tools.length} tools · {skill.memorySections.length} memory sections
        </span>
        {!expanded && (
          <button
            onClick={() => setExpanded(true)}
            style={{ ...btnGhost, marginLeft: "auto" }}
          >
            Configure
          </button>
        )}
      </div>

      {skill.tools.length > 0 && (
        <div style={{ fontSize: 11, color: C.mut, marginTop: 4, marginLeft: 22 }}>
          Tools: {skill.tools.join(", ")}
        </div>
      )}

      {/* Expanded form */}
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.brd}` }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={lbl}>Provider override</label>
              <select
                value={providerDraft}
                onChange={(e) => setProviderDraft(e.target.value as SkillProvider | "")}
                style={inp}
              >
                <option value="">(inherit tier provider)</option>
                {SKILL_PROVIDERS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={lbl}>Model override</label>
              <input
                list={`skill-models-${skill.skillName}`}
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                placeholder="e.g. gpt-4o-mini (blank = inherit tier model)"
                spellCheck={false}
                style={inp}
              />
              <datalist id={`skill-models-${skill.skillName}`}>
                {catalog.map((r) => (
                  <option key={r.modelId} value={r.modelId}>
                    {r.displayName ?? r.modelId}
                  </option>
                ))}
              </datalist>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={lbl}>
                API key {skill.apiKeyConfigured ? "(leave blank to keep saved key)" : "(leave blank to inherit from tier)"}
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                  placeholder={skill.apiKeyConfigured ? "•••••••••••• (saved)" : "Leave blank to inherit from tier"}
                  autoComplete="off"
                  style={{ ...inp, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  style={btnGhost}
                >
                  {showKey ? "Hide" : "Show"}
                </button>
                {skill.apiKeyConfigured && (
                  <button
                    type="button"
                    onClick={onClearKey}
                    style={{ ...btnGhost, color: C.red }}
                    title="Clear the skill's saved API key — falls back to tier provider's key."
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={lbl}>Base URL (optional — for self-hosted proxies)</label>
              <input
                value={baseUrlDraft}
                onChange={(e) => setBaseUrlDraft(e.target.value)}
                placeholder="(leave blank for provider default)"
                style={inp}
              />
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
            <button
              onClick={onTest}
              disabled={testing || saving}
              style={{
                ...btnGhost,
                cursor: testing ? "not-allowed" : "pointer",
                opacity: testing ? 0.6 : 1,
              }}
              title="Run a 1-token call against (provider, model, key) to verify connectivity."
            >
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button
              onClick={onSaveClick}
              disabled={saving || testing}
              style={{
                ...btn1,
                background: saving ? C.mut : "#F97316",
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {saveMsg && <span style={{ fontSize: 12, color: C.grn }}>{saveMsg}</span>}
          </div>

          {testResult && (
            <div style={{
              marginTop: 10, padding: 8, borderRadius: 6, fontSize: 12, lineHeight: 1.4,
              background: testResult.ok ? C.grnBg : C.redBg,
              color: testResult.ok ? C.grn : C.red,
            }}>
              {testResult.ok ? (
                <>
                  <strong>✓ Connection OK</strong>
                  {testResult.provider && testResult.model ? ` — ${testResult.provider}/${testResult.model}` : ""}
                  {typeof testResult.latencyMs === "number" ? ` · ${testResult.latencyMs} ms` : ""}
                  {testResult.preview && (
                    <div style={{ marginTop: 4, color: C.sub, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                      "{testResult.preview}"
                    </div>
                  )}
                </>
              ) : (
                <><strong>✗ Test failed</strong> — {testResult.error}</>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const lbl: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: C.sub, textTransform: "uppercase",
  letterSpacing: 0.5, marginBottom: 4, display: "block",
};
const inp: React.CSSProperties = {
  width: "100%", padding: "6px 10px", borderRadius: 6,
  border: `1px solid ${C.brd}`, fontSize: 12, fontFamily: F, background: "#fff",
  boxSizing: "border-box",
};

// ── Runs tab ──────────────────────────────────────────────────────────────────
function RunsTab({ agent }: { agent: string }) {
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError("");
    get<{ runs: RunEntry[] }>(`/agents/${agent}/runs?limit=100`)
      .then(r => setRuns(r.runs))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [agent]);

  if (error) return <div style={{ background: C.redBg, color: C.red, padding: 10, borderRadius: 8 }}>{error}</div>;

  if (loading && runs.length === 0) {
    return (
      <div style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 8, padding: 16 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: i < 3 ? `1px solid ${C.brd}` : "none" }}>
            <div style={{ width: "20%", height: 10, background: "#EEE", borderRadius: 3 }} />
            <div style={{ width: "20%", height: 10, background: "#F2F2F2", borderRadius: 3 }} />
            <div style={{ width: "15%", height: 10, background: "#F2F2F2", borderRadius: 3 }} />
            <div style={{ width: "10%", height: 10, background: "#F2F2F2", borderRadius: 3 }} />
          </div>
        ))}
        <div style={{ fontSize: 11, color: C.mut, fontStyle: "italic", paddingTop: 10, textAlign: "center" }}>Loading run history…</div>
      </div>
    );
  }

  return (
    <div style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 8, overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: F }}>
        <thead style={{ background: "#FAFAFA" }}>
          <tr>
            <th style={th}>Time</th>
            <th style={th}>Skill</th>
            <th style={th}>Caller</th>
            <th style={th}>Status</th>
            <th style={{ ...th, textAlign: "right" }}>In</th>
            <th style={{ ...th, textAlign: "right" }}>Out</th>
            <th style={{ ...th, textAlign: "right" }}>Cache</th>
            <th style={{ ...th, textAlign: "right" }}>ms</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && (
            <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: C.mut }}>No runs yet for this agent.</td></tr>
          )}
          {runs.map(r => (
            <tr key={r.id} style={{ borderTop: `1px solid ${C.brd}` }}>
              <td style={td}>{new Date(r.createdAt).toLocaleString()}</td>
              <td style={td}>{r.skill}</td>
              <td style={td}>{r.caller || "—"}</td>
              <td style={{ ...td, color: r.status === "error" ? C.red : C.grn }}>{r.status}</td>
              <td style={{ ...td, textAlign: "right" }}>{r.inputTokens ?? 0}</td>
              <td style={{ ...td, textAlign: "right" }}>{r.outputTokens ?? 0}</td>
              <td style={{ ...td, textAlign: "right", color: C.blu }}>{r.cacheReadTokens ?? 0}</td>
              <td style={{ ...td, textAlign: "right" }}>{r.durationMs ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const th: React.CSSProperties = { padding: "8px 12px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase" };
const td: React.CSSProperties = { padding: "6px 12px", color: C.tx };

function Card({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      flex: 1, padding: "10px 14px", background: C.card,
      border: `1px solid ${C.brd}`, borderRadius: 10,
    }}>
      <div style={{ fontSize: 11, color: C.mut, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function FeedbackRowCard({ row, selected, onToggle }: { row: FeedbackRow; selected: boolean; onToggle: () => void }) {
  const ratingIcon = row.rating === 1 ? "👍" : row.rating === -1 ? "👎" : "•";
  return (
    <label style={{
      display: "flex", gap: 12, padding: "10px 14px", marginBottom: 6,
      background: selected ? C.bluBg : C.card,
      border: `1px solid ${selected ? C.blu : C.brd}`,
      borderRadius: 8, cursor: "pointer",
    }}>
      <input type="checkbox" checked={selected} onChange={onToggle} style={{ marginTop: 4 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.sub }}>
          <span>{ratingIcon}</span>
          <span style={{ fontWeight: 700, color: C.tx }}>{row.skill}</span>
          <span style={{ background: "#F3F4F6", padding: "1px 6px", borderRadius: 4, fontSize: 10 }}>{row.sourceType}</span>
          <span style={{ color: C.mut, marginLeft: "auto", fontSize: 11 }}>{new Date(row.createdAt).toLocaleString()}</span>
        </div>
        {row.reviewText && (
          <div style={{ marginTop: 6, fontSize: 13, color: C.tx, lineHeight: 1.4 }}>{row.reviewText}</div>
        )}
        <div style={{ marginTop: 4, fontSize: 11, color: C.mut, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          source_id: {row.sourceId}
        </div>
      </div>
    </label>
  );
}

function ProposalCard({ proposal, onDecide }: { proposal: ProposalRow; onDecide: (id: string, action: "approve" | "reject", reason?: string) => void }) {
  const [showDiffs, setShowDiffs] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.blu}`, borderRadius: 10,
      padding: 14, marginBottom: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 999, background: C.bluBg, color: C.blu, fontWeight: 700 }}>PENDING</span>
        <span style={{ marginLeft: 10, fontSize: 11, color: C.mut }}>{new Date(proposal.createdAt).toLocaleString()}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: C.mut }}>{proposal.feedbackIds.length} feedback rows · {proposal.diffs.length} sections</span>
      </div>
      <div style={{ fontSize: 14, color: C.tx, marginBottom: 10, lineHeight: 1.5 }}>{proposal.reason}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => setShowDiffs(s => !s)} style={btnGhost}>{showDiffs ? "Hide" : "View"} diffs</button>
        <button onClick={() => onDecide(proposal.id, "approve")} style={{ ...btn1, background: C.grn }}>Approve all</button>
        <button onClick={() => onDecide(proposal.id, "reject", rejectReason)} style={{ ...btn1, background: C.red }}>Reject</button>
        <input
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="optional rejection reason"
          style={{ flex: 1, padding: "4px 8px", fontSize: 12, border: `1px solid ${C.brd}`, borderRadius: 6 }}
        />
      </div>
      {showDiffs && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.brd}` }}>
          {proposal.diffs.map((d, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.tx, marginBottom: 4 }}>
                {d.section_name} <span style={{ color: C.mut, fontWeight: 400 }}>({d.kind})</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11 }}>
                <pre style={{ background: C.redBg, padding: 8, borderRadius: 6, overflow: "auto", margin: 0, maxHeight: 240 }}>
                  {d.before || "(empty)"}
                </pre>
                <pre style={{ background: C.grnBg, padding: 8, borderRadius: 6, overflow: "auto", margin: 0, maxHeight: 240 }}>
                  {d.after}
                </pre>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const btn1: React.CSSProperties = {
  padding: "6px 14px", fontSize: 12, fontWeight: 700,
  border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", fontFamily: F,
};
const btnGhost: React.CSSProperties = {
  padding: "6px 12px", fontSize: 12, fontWeight: 600,
  border: `1px solid ${C.brd}`, borderRadius: 8, background: "#fff",
  color: C.sub, cursor: "pointer", fontFamily: F,
};
