import { useState, useEffect, useMemo } from "react";
import { get, post, patch, del } from "@/lib/api";
import { C, F, FS, btn1, btn2 } from "./constants";
import { showToast } from "./Toast";
import type { Idea } from "./types";

interface Props {
  ideas: Idea[];
  onIdeasChange: (ideas: Idea[]) => void;
  onCreateTask?: (ideaText: string, category: string, urgency: string, techType?: string) => void;
  onNavigate: (view: string) => void;
  onNewIdea?: () => void;
}

const CATS = ["Tech", "Sales", "Marketing", "Strategic Partners", "Operations", "Product", "Personal"];
const URGS = ["Now", "This Week", "This Month", "Someday"];
const TYPES = ["Bug", "Feature", "Note", "Task", "Strategic"];

const CAT_COLOR: Record<string, string> = {
  Tech: "#DC2626", Sales: "#16A34A", Marketing: "#9333EA", "Strategic Partners": "#2563EB",
  Operations: "#D97706", Product: "#0891B2", Personal: "#6B7280",
};
const URG_COLOR: Record<string, string> = {
  Now: "#DC2626", "This Week": "#D97706", "This Month": "#2563EB", Someday: "#6B7280",
};

// Relative-time formatter for the parking-lot cards. "2h ago", "3d ago",
// then falls back to "Mar 12" once it's older than a week. Tony scans this
// list quickly — a relative number is faster to read than a date.
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

// ─── Idea Detail Modal ───────────────────────────────────────────────────────
function IdeaDetailModal({ idea, onClose, onUpdated, onDeleted, onCreateTask }: {
  idea: any;
  onClose: () => void;
  onUpdated: (updated: any) => void;
  onDeleted: (id: string) => void;
  onCreateTask?: (ideaText: string, category: string, urgency: string, techType?: string) => void;
}) {
  const [tab, setTab] = useState<"details" | "ai">("details");
  const [form, setForm] = useState({
    text: idea.text || "", category: idea.category || "", urgency: idea.urgency || "",
    techType: idea.techType || "", assigneeName: idea.assigneeName || "", assigneeEmail: idea.assigneeEmail || "",
    dueDate: idea.dueDate || "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rethinking, setRethinking] = useState(false);
  // Hydrate the AI reflection from the idea row if Coach already produced
  // one for it. Re-clicking "AI Rethink" overwrites this with a fresh
  // classification (and persists the new JSON via the rethink endpoint).
  const [aiReflection, setAiReflection] = useState<any>(() => {
    if (!idea.aiReflection) return null;
    try { return JSON.parse(idea.aiReflection); }
    catch { return null; }
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [parking, setParking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notifying, setNotifying] = useState<null | "slack" | "email" | "ethan">(null);
  // Team members fed both the Assignment dropdown AND the AI Reflection tab's
  // Slack-id lookup. Fetched once when the modal opens so the dropdown is
  // ready immediately and the Slack-button tooltip resolves without a second
  // round-trip.
  type TeamMember = { name: string; email: string | null; slackId?: string | null };
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [assigneeMode, setAssigneeMode] = useState<"team" | "custom">(
    () => idea.assigneeName && !idea.assigneeEmail ? "custom" : "team"
  );
  useEffect(() => {
    get<{ ok: boolean; members: TeamMember[] }>("/ideas/team-members")
      .then(res => { if (res?.ok) setTeamMembers(res.members); })
      .catch(() => {});
  }, []);

  const assigneeSlackId = useMemo(() => {
    if (!idea.assigneeName && !idea.assigneeEmail) return null;
    const m = teamMembers.find(mm =>
      (idea.assigneeName && mm.name?.toLowerCase() === String(idea.assigneeName).toLowerCase()) ||
      (idea.assigneeEmail && mm.email && mm.email.toLowerCase() === String(idea.assigneeEmail).toLowerCase())
    );
    return m?.slackId || null;
  }, [teamMembers, idea.assigneeName, idea.assigneeEmail]);

  const hasChanges = form.text !== (idea.text || "") || form.category !== (idea.category || "") ||
    form.urgency !== (idea.urgency || "") || form.techType !== (idea.techType || "") ||
    form.assigneeName !== (idea.assigneeName || "") || form.assigneeEmail !== (idea.assigneeEmail || "") ||
    form.dueDate !== (idea.dueDate || "");

  const URGENCY_ORDER = ["Now", "This Week", "This Month", "Someday"];

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await patch<any>(`/ideas/${idea.id}`, form);
      onUpdated({ ...idea, ...updated });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      // Notify Ethan if urgency was escalated to something more urgent
      const oldIdx = URGENCY_ORDER.indexOf(idea.urgency);
      const newIdx = URGENCY_ORDER.indexOf(form.urgency);
      if (newIdx < oldIdx && (form.urgency === "Now" || form.urgency === "This Week")) {
        post("/ideas/escalate-to-ethan", {
          text: form.text,
          rank: null,
          reasoning: `Urgency escalated from ${idea.urgency} to ${form.urgency}`,
          ideaId: idea.id,
          category: form.category,
          urgency: form.urgency,
        }).catch(() => {});
      }
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleRethink = async () => {
    setRethinking(true);
    try {
      const res = await post<{ ok: boolean; idea: any; classification: any; error?: string }>(`/ideas/${idea.id}/rethink`, {});
      if (res?.ok) {
        setAiReflection(res.classification);
        if (res.idea) {
          // Backend persists aiReflection in the rethink endpoint, so the
          // returned idea row already carries the new JSON — propagate it
          // to the parent so the list view also reflects the change.
          onUpdated({ ...idea, ...res.idea });
          setForm(f => ({ ...f, category: res.idea.category || f.category, urgency: res.idea.urgency || f.urgency, techType: res.idea.techType || f.techType }));
        }
        showToast({ title: "Reflection updated" });
      } else {
        setAiReflection({ error: res?.error || "AI returned an unexpected response. Please try again." });
      }
    } catch (err) {
      // Surface the real error message instead of the generic fallback —
      // failures are usually transient (rate limit, JSON parse, network)
      // not depleted credits.
      const msg = err instanceof Error ? err.message : String(err);
      setAiReflection({ error: `AI rethink failed: ${msg}` });
    }
    setRethinking(false);
  };

  // Map server error codes to friendly messages. Falls back to a stripped /
  // truncated raw message for unknown codes — never shows an HTML 404 body in
  // a toast.
  const friendlyError = (raw: string | undefined, fallback: string): string => {
    if (!raw) return fallback;
    const stripped = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const codes: Record<string, string> = {
      no_assignee: "No assignee on this idea",
      no_email: "Assignee has no email on file",
      no_slack_id: "Assignee has no Slack ID linked",
      slack_failed: "Slack rejected the message",
      email_failed: "Gmail rejected the send — see server logs",
    };
    if (codes[stripped]) return codes[stripped];
    if (/cannot post/i.test(stripped)) return "Endpoint not available — try refreshing the page";
    // Common Gmail OAuth failure modes — show actionable messages.
    if (/invalid_grant|expired/i.test(stripped)) return "Gmail OAuth expired — re-authenticate in Google integration settings";
    if (/insufficient.*scope|insufficientPermissions/i.test(stripped)) return "Gmail OAuth missing send scope — re-authorize with gmail.send";
    return stripped.slice(0, 220);
  };

  const handleNotifySlack = async () => {
    if (notifying) return;
    setNotifying("slack");
    try {
      const r = await post<{ ok: boolean; error?: string }>(`/ideas/${idea.id}/notify-assignee-slack`, {});
      if (r?.ok) showToast({ title: "Slack DM sent to assignee" });
      else showToast({ title: "Couldn't DM assignee", description: friendlyError(r?.error, "Slack send failed"), variant: "error" });
    } catch (err) {
      showToast({ title: "Couldn't DM assignee", description: friendlyError(err instanceof Error ? err.message : String(err), "Network error"), variant: "error" });
    }
    setNotifying(null);
  };

  const handleNotifyEmail = async () => {
    if (notifying) return;
    setNotifying("email");
    try {
      const r = await post<{ ok: boolean; error?: string }>(`/ideas/${idea.id}/notify-assignee-email`, {});
      if (r?.ok) showToast({ title: "Email sent to assignee" });
      else showToast({ title: "Couldn't email assignee", description: friendlyError(r?.error, "Email send failed"), variant: "error" });
    } catch (err) {
      showToast({ title: "Couldn't email assignee", description: friendlyError(err instanceof Error ? err.message : String(err), "Network error"), variant: "error" });
    }
    setNotifying(null);
  };

  // Notify Ethan reuses the existing /ideas/notify-park endpoint — same Slack
  // DM channel (Ethan's user ID) used elsewhere for "park-only" notifications.
  const handleNotifyEthan = async () => {
    if (notifying) return;
    setNotifying("ethan");
    try {
      const r = await post<{ ok: boolean; slackOk?: boolean }>("/ideas/notify-park", {
        text: idea.text, category: idea.category, urgency: idea.urgency, ideaId: idea.id,
      });
      if (r?.slackOk) showToast({ title: "Ethan notified on Slack" });
      else showToast({ title: "Slack DM may have failed", description: "Check #engineering or retry", variant: "error" });
    } catch (err) {
      showToast({ title: "Couldn't notify Ethan", description: friendlyError(err instanceof Error ? err.message : String(err), "Network error"), variant: "error" });
    }
    setNotifying(null);
  };

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await del(`/ideas/${idea.id}`);
      showToast({ title: "Idea deleted" });
      onDeleted(idea.id);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ title: "Failed to delete idea", description: msg, variant: "error" });
      setDeleting(false);
    }
  };

  const handlePark = async () => {
    if (idea.status === "parked") return; // already parked — no-op
    setParking(true);
    try {
      const updated = await patch<any>(`/ideas/${idea.id}`, { status: "parked", urgency: "Someday" });
      onUpdated({ ...idea, ...updated, status: "parked", urgency: "Someday" });
      // Park only — do NOT auto-open the task creation modal. Users who want
      // a task for the parked idea can click "Convert to Task" explicitly.
      onClose();
    } catch { /* ignore */ }
    setParking(false);
  };

  const isParked = idea.status === "parked";
  const isOverride = idea.status === "override";

  const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 7, border: `1px solid ${C.brd}`, fontFamily: F, fontSize: 13, background: "#fff", boxSizing: "border-box" };
  const lbl: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" };

  const urgAccent = URG_COLOR[idea.urgency] || "#888";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 10000, display: "flex", justifyContent: "flex-end" }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: 540, maxWidth: "95vw", background: C.bg, height: "100vh", overflowY: "auto", boxShadow: "-4px 0 20px rgba(0,0,0,0.15)", borderTop: `3px solid ${urgAccent}` }}>
        {/* Header — title prominent on top, badges in a single row below */}
        <div style={{ padding: "18px 22px 14px", borderBottom: `1px solid ${C.brd}`, background: C.card }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: FS, color: C.tx, lineHeight: 1.35, flex: 1 }}>
              {idea.text.substring(0, 80)}{idea.text.length > 80 ? "…" : ""}
            </div>
            <button onClick={onClose} title="Close" style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.mut, lineHeight: 1, padding: 0, flexShrink: 0 }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: CAT_COLOR[idea.category] || "#888", color: "#fff", letterSpacing: 0.2 }}>{idea.category}</span>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: URG_COLOR[idea.urgency] || "#888", color: "#fff", letterSpacing: 0.2 }}>{idea.urgency}</span>
            {idea.techType && <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "#E5E7EB", color: "#374151" }}>{idea.techType}</span>}
            {/* Status pill — override and parked are distinct: override = "Tony forced this through despite AI pushback", parked = "intentionally deferred to Someday". They can also stack (override first, then later parked). */}
            {isOverride && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "#FEE2E2", color: "#DC2626" }}>OVERRIDE</span>
            )}
            {isParked && (
              <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "#F3F4F6", color: "#6B7280" }}>parked</span>
            )}
            {!isOverride && !isParked && (
              <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "#DCFCE7", color: "#166534" }}>active</span>
            )}
            {idea.linearIdentifier && <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: "#EBF5FF", color: "#2563EB", fontFamily: "monospace" }}>{idea.linearIdentifier}</span>}
          </div>
        </div>

        {/* Tabs — cleaner, with the active tab using the orange brand accent
            instead of a flat black underline so it matches the rest of TCC. */}
        <div style={{ display: "flex", borderBottom: `1px solid ${C.brd}`, background: C.card }}>
          {(["details", "ai"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: "11px 0", fontSize: 13, fontWeight: 600, fontFamily: F, cursor: "pointer",
              background: "none", border: "none",
              borderBottom: tab === t ? "2px solid #F97316" : "2px solid transparent",
              color: tab === t ? "#111" : C.mut,
              transition: "color 0.12s",
            }}>{t === "details" ? "Details" : "AI Reflection"}</button>
          ))}
        </div>

        <div style={{ padding: "16px 20px" }}>
          {/* ── Details Tab ── */}
          {tab === "details" && (
            <div>
              <div style={{ marginBottom: 14 }}>
                <label style={lbl}>Idea Text</label>
                <textarea value={form.text} onChange={e => setForm(f => ({ ...f, text: e.target.value }))} rows={3} style={{ ...inp, resize: "vertical" }} />
              </div>

              {/* Classification block */}
              <div style={{ fontSize: 10, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 0.6, margin: "6px 0 8px" }}>Classification</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={lbl}>Category</label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={inp}>{CATS.map(c => <option key={c}>{c}</option>)}</select>
                </div>
                <div>
                  <label style={lbl}>Urgency</label>
                  <select value={form.urgency} onChange={e => setForm(f => ({ ...f, urgency: e.target.value }))} style={inp}>{URGS.map(u => <option key={u}>{u}</option>)}</select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
                <div>
                  <label style={lbl}>Type</label>
                  <select value={form.techType} onChange={e => setForm(f => ({ ...f, techType: e.target.value }))} style={inp}>
                    <option value="">None</option>
                    {TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl}>Due Date</label>
                  <input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} style={inp} />
                </div>
              </div>

              {/* Assignment block — dropdown auto-maps email from team_roles
                  (same UX as task creation). Custom mode falls back to manual
                  name + email entry for someone not in the roster. */}
              <div style={{ fontSize: 10, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 0.6, margin: "6px 0 8px" }}>Assignment</div>
              <div style={{ marginBottom: 18 }}>
                <label style={lbl}>Assignee {teamMembers.length > 0 && <span style={{ color: C.grn, fontWeight: 400 }}>({teamMembers.length} from team roster)</span>}</label>
                <select
                  value={assigneeMode === "custom" ? "__custom__" : (form.assigneeName ? `${form.assigneeName}|${form.assigneeEmail}` : "")}
                  onChange={e => {
                    const val = e.target.value;
                    if (!val) {
                      setAssigneeMode("team");
                      setForm(f => ({ ...f, assigneeName: "", assigneeEmail: "" }));
                    } else if (val === "__custom__") {
                      setAssigneeMode("custom");
                      setForm(f => ({ ...f, assigneeName: "", assigneeEmail: "" }));
                    } else {
                      const [name, email] = val.split("|");
                      setAssigneeMode("team");
                      setForm(f => ({ ...f, assigneeName: name, assigneeEmail: email || "" }));
                    }
                  }}
                  style={{ ...inp, cursor: "pointer" }}
                >
                  <option value="">— No assignee —</option>
                  {teamMembers.map(m => (
                    <option key={`${m.name}|${m.email || ""}`} value={`${m.name}|${m.email || ""}`}>
                      {m.name}{m.slackId ? " ✓ Slack" : ""}{m.email ? ` · ${m.email}` : " (Slack only)"}
                    </option>
                  ))}
                  <option value="__custom__">+ Enter custom name &amp; email...</option>
                </select>
                {assigneeMode === "custom" && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
                    <input value={form.assigneeName} onChange={e => setForm(f => ({ ...f, assigneeName: e.target.value }))} style={inp} placeholder="Name (e.g. Ethan)" />
                    <input type="email" value={form.assigneeEmail} onChange={e => setForm(f => ({ ...f, assigneeEmail: e.target.value }))} style={inp} placeholder="email@example.com" />
                  </div>
                )}
              </div>

              {/* Save button */}
              {hasChanges && (
                <button onClick={handleSave} disabled={saving} style={{ ...btn1, width: "100%", marginBottom: 12, opacity: saving ? 0.6 : 1 }}>
                  {saving ? "Saving..." : saved ? "Saved!" : "Save Changes"}
                </button>
              )}

              {/* Action buttons */}
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <button onClick={() => { if (onCreateTask) onCreateTask(form.text, form.category, form.urgency, form.techType || undefined); onClose(); }}
                  style={{ flex: 1, padding: "8px 12px", borderRadius: 7, border: `1px solid #16A34A`, background: "#DCFCE7", color: "#166534", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: F }}>
                  Convert to Task
                </button>
                <button
                  onClick={handlePark}
                  disabled={isParked || parking}
                  title={isParked ? "Already parked" : "Park this idea (move to Someday)"}
                  style={{
                    flex: 1, padding: "8px 12px", borderRadius: 7,
                    border: `1px solid ${C.brd}`, background: "#F3F4F6",
                    color: isParked ? "#9CA3AF" : "#374151",
                    fontSize: 12, fontWeight: 700, fontFamily: F,
                    cursor: isParked || parking ? "not-allowed" : "pointer",
                    opacity: isParked || parking ? 0.6 : 1,
                  }}
                >
                  {parking ? "Parking..." : isParked ? "✓ Parked" : "Park Idea"}
                </button>
              </div>

              {/* Delete */}
              {confirmDelete ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={handleDelete} disabled={deleting} style={{ flex: 1, padding: "8px", borderRadius: 7, border: "none", background: "#DC2626", color: "#fff", fontSize: 12, fontWeight: 700, cursor: deleting ? "not-allowed" : "pointer", opacity: deleting ? 0.6 : 1 }}>
                    {deleting ? "Deleting…" : "Confirm Delete"}
                  </button>
                  <button onClick={() => setConfirmDelete(false)} disabled={deleting} style={{ flex: 1, padding: "8px", borderRadius: 7, border: `1px solid ${C.brd}`, background: "#fff", fontSize: 12, cursor: deleting ? "not-allowed" : "pointer", opacity: deleting ? 0.6 : 1 }}>Cancel</button>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(true)} style={{ width: "100%", padding: "8px", borderRadius: 7, border: `1px solid #FECACA`, background: "#FEF2F2", color: "#DC2626", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: F }}>Delete Idea</button>
              )}

              {/* Metadata */}
              <div style={{ marginTop: 16, padding: "12px", background: "#F9FAFB", borderRadius: 8, fontSize: 11, color: C.mut }}>
                <div>Created: {idea.createdAt ? new Date(idea.createdAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }) : "—"}</div>
                {idea.linearIdentifier && <div>Linear: {idea.linearIdentifier}</div>}
                {idea.assigneeName && <div>Assigned: {idea.assigneeName} ({idea.assigneeEmail || "—"})</div>}
              </div>
            </div>
          )}

          {/* ── AI Reflection Tab ── */}
          {tab === "ai" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: FS }}>AI Analysis</div>
                <button onClick={handleRethink} disabled={rethinking} style={{
                  padding: "6px 14px", borderRadius: 7, border: `1px solid ${C.brd}`, background: rethinking ? "#FEF9C3" : "#fff",
                  fontSize: 12, fontWeight: 600, cursor: rethinking ? "default" : "pointer", color: "#D97706", fontFamily: F,
                }}>{rethinking ? "Rethinking..." : "AI Rethink"}</button>
              </div>

              {aiReflection ? (
                <div style={{ background: "#FFFBEB", border: "1px solid #F59E0B", borderRadius: 8, padding: "14px 16px" }}>
                  {aiReflection.error ? (
                    <div style={{ color: "#DC2626", fontSize: 13 }}>{aiReflection.error}</div>
                  ) : (
                    <>
                      <div style={{ marginBottom: 8 }}><span style={{ fontWeight: 700, fontSize: 12 }}>Category:</span> <span style={{ fontSize: 13 }}>{aiReflection.category}</span></div>
                      <div style={{ marginBottom: 8 }}><span style={{ fontWeight: 700, fontSize: 12 }}>Urgency:</span> <span style={{ fontSize: 13 }}>{aiReflection.urgency}</span></div>
                      <div style={{ marginBottom: 8 }}><span style={{ fontWeight: 700, fontSize: 12 }}>Type:</span> <span style={{ fontSize: 13 }}>{aiReflection.techType || "—"}</span></div>
                      <div style={{ marginBottom: 8 }}><span style={{ fontWeight: 700, fontSize: 12 }}>Priority:</span> <span style={{ fontSize: 13, color: aiReflection.priority === "high" ? "#DC2626" : aiReflection.priority === "medium" ? "#D97706" : "#16A34A" }}>{aiReflection.priority}</span></div>
                      {aiReflection.reason && <div style={{ marginBottom: 8 }}><span style={{ fontWeight: 700, fontSize: 12 }}>Reason:</span> <span style={{ fontSize: 13 }}>{aiReflection.reason}</span></div>}
                      {aiReflection.businessFit && <div style={{ marginBottom: 8 }}><span style={{ fontWeight: 700, fontSize: 12 }}>Business Fit:</span> <span style={{ fontSize: 13 }}>{aiReflection.businessFit}</span></div>}
                      {aiReflection.warningIfDistraction && <div style={{ padding: 10, background: "#FEE2E2", borderRadius: 6, fontSize: 12, color: "#DC2626", marginTop: 8 }}>{aiReflection.warningIfDistraction}</div>}
                    </>
                  )}
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "32px 0", color: C.mut }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🤖</div>
                  <div style={{ fontSize: 13 }}>Click "AI Rethink" to get AI analysis on this idea</div>
                  <div style={{ fontSize: 11, marginTop: 4 }}>AI will re-evaluate the category, urgency, priority, and business fit</div>
                </div>
              )}

              {/* Action buttons — share this reflection with assignee or Ethan */}
              {aiReflection && !aiReflection.error && (() => {
                const hasAssignee = !!(idea.assigneeName || idea.assigneeEmail);
                const slackTooltip = !hasAssignee ? "No assignee on this idea" : !idea.assigneeName ? "Assignee name missing" : assigneeSlackId === undefined ? "Looking up Slack ID…" : assigneeSlackId ? "" : "No Slack ID for assignee";
                const slackEnabled = hasAssignee && !!idea.assigneeName && !!assigneeSlackId;
                const emailTooltip = !idea.assigneeEmail ? "No email for assignee" : "";
                const emailEnabled = !!idea.assigneeEmail;
                return (
                  <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>Share reflection</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={handleNotifySlack}
                        disabled={!slackEnabled || notifying === "slack"}
                        title={slackTooltip || "DM the assignee on Slack with this reflection"}
                        style={{
                          flex: 1, padding: "8px 10px", borderRadius: 7,
                          border: `1px solid ${slackEnabled ? "#1D9353" : C.brd}`,
                          background: slackEnabled ? "#E8F5E9" : "#F3F4F6",
                          color: slackEnabled ? "#1D9353" : C.mut,
                          fontSize: 11, fontWeight: 700, fontFamily: F,
                          cursor: slackEnabled && notifying !== "slack" ? "pointer" : "not-allowed",
                          opacity: slackEnabled ? 1 : 0.55,
                        }}
                      >
                        {notifying === "slack" ? "Sending…" : "💬 Slack assignee"}
                      </button>
                      <button
                        onClick={handleNotifyEmail}
                        disabled={!emailEnabled || notifying === "email"}
                        title={emailTooltip || "Email the assignee this reflection"}
                        style={{
                          flex: 1, padding: "8px 10px", borderRadius: 7,
                          border: `1px solid ${emailEnabled ? "#1565C0" : C.brd}`,
                          background: emailEnabled ? "#EFF6FF" : "#F3F4F6",
                          color: emailEnabled ? "#1565C0" : C.mut,
                          fontSize: 11, fontWeight: 700, fontFamily: F,
                          cursor: emailEnabled && notifying !== "email" ? "pointer" : "not-allowed",
                          opacity: emailEnabled ? 1 : 0.55,
                        }}
                      >
                        {notifying === "email" ? "Sending…" : "📧 Email assignee"}
                      </button>
                      <button
                        onClick={handleNotifyEthan}
                        disabled={notifying === "ethan"}
                        title="DM Ethan on Slack about this idea"
                        style={{
                          flex: 1, padding: "8px 10px", borderRadius: 7,
                          border: `1px solid #F97316`,
                          background: "#FFF7ED",
                          color: "#C2410C",
                          fontSize: 11, fontWeight: 700, fontFamily: F,
                          cursor: notifying === "ethan" ? "not-allowed" : "pointer",
                          opacity: notifying === "ethan" ? 0.6 : 1,
                        }}
                      >
                        {notifying === "ethan" ? "Notifying…" : "🚨 Notify Ethan"}
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Ideas View ─────────────────────────────────────────────────────────
export function IdeasView({ ideas, onIdeasChange, onCreateTask, onNavigate, onNewIdea }: Props) {
  const [allIdeas, setAllIdeas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIdea, setSelectedIdea] = useState<any | null>(null);
  const [filter, setFilter] = useState<"all" | "parked" | "override">("all");

  useEffect(() => {
    setLoading(true);
    get<any[]>("/ideas").then(d => { setAllIdeas(d || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const filtered = filter === "all" ? allIdeas : allIdeas.filter(i => i.status === filter);

  return (
    <div style={{ padding: "24px 20px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontFamily: FS, fontSize: 22, margin: 0 }}>Ideas Parking Lot</h2>
          <div style={{ fontSize: 12, color: C.mut, marginTop: 2 }}>{allIdeas.length} ideas total — {allIdeas.filter(i => i.status === "parked").length} parked</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {onNewIdea && <button onClick={onNewIdea} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: "#F97316", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: F }}>+ New Idea</button>}
          {(["all", "parked", "override"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
              background: filter === f ? "#111" : "#F3F4F6", color: filter === f ? "#fff" : "#374151",
              border: `1px solid ${filter === f ? "#111" : "#D1D5DB"}`,
            }}>{f === "all" ? "All" : f === "parked" ? "Parked" : "Overrides"}</button>
          ))}
        </div>
      </div>

      {/* Ideas List */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: C.mut }}>Loading ideas...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: C.mut }}>No ideas found</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {filtered.map(idea => {
            const urgColor = URG_COLOR[idea.urgency] || "#888";
            const catColor = CAT_COLOR[idea.category] || "#888";
            const createdTitle = idea.createdAt ? new Date(idea.createdAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }) : "";
            return (
              // Card uses a colored left accent (urgency) so Tony can spot
              // "Now"/"This Week" rows at a glance — denser padding + a single
              // row of badges to keep the list scannable.
              <div
                key={idea.id}
                onClick={() => setSelectedIdea(idea)}
                style={{
                  background: C.card,
                  border: `1px solid ${C.brd}`,
                  borderLeft: `4px solid ${urgColor}`,
                  borderRadius: 8,
                  padding: "10px 14px 10px 12px",
                  cursor: "pointer",
                  transition: "all 0.12s",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.boxShadow = "0 2px 10px rgba(0,0,0,0.06)";
                  e.currentTarget.style.transform = "translateX(1px)";
                  e.currentTarget.style.background = "#FFFDF7";
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.boxShadow = "none";
                  e.currentTarget.style.transform = "translateX(0)";
                  e.currentTarget.style.background = C.card;
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: C.tx,
                    marginBottom: 4,
                    lineHeight: 1.35,
                    // Keep the text on one line — Tony scans titles, full text
                    // is still available in the detail drawer.
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}>{idea.text}</div>
                  <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "nowrap", overflow: "hidden" }}>
                    <span style={{ fontSize: 9.5, fontWeight: 700, padding: "1.5px 7px", borderRadius: 3, background: catColor, color: "#fff", letterSpacing: 0.2 }}>{idea.category}</span>
                    <span style={{ fontSize: 9.5, fontWeight: 700, padding: "1.5px 7px", borderRadius: 3, background: urgColor, color: "#fff", letterSpacing: 0.2 }}>{idea.urgency}</span>
                    {idea.techType && <span style={{ fontSize: 9.5, fontWeight: 600, padding: "1.5px 7px", borderRadius: 3, background: "#E5E7EB", color: "#374151" }}>{idea.techType}</span>}
                    {idea.status === "override" && <span style={{ fontSize: 9.5, fontWeight: 700, padding: "1.5px 7px", borderRadius: 3, background: "#FEE2E2", color: "#DC2626" }}>OVERRIDE</span>}
                    {idea.status === "parked" && <span style={{ fontSize: 9.5, fontWeight: 600, padding: "1.5px 7px", borderRadius: 3, background: "#F3F4F6", color: "#6B7280" }}>parked</span>}
                    {idea.linearIdentifier && <span style={{ fontSize: 9.5, fontWeight: 600, padding: "1.5px 7px", borderRadius: 3, background: "#EBF5FF", color: "#2563EB", fontFamily: "monospace" }}>{idea.linearIdentifier}</span>}
                    {idea.assigneeName && <span style={{ fontSize: 10, color: C.mut, marginLeft: 4 }}>· {idea.assigneeName}</span>}
                  </div>
                </div>
                <div title={createdTitle} style={{ fontSize: 11, color: C.mut, whiteSpace: "nowrap", flexShrink: 0 }}>
                  {timeAgo(idea.createdAt)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      {selectedIdea && (
        <IdeaDetailModal
          idea={selectedIdea}
          onClose={() => setSelectedIdea(null)}
          onUpdated={(updated) => {
            setAllIdeas(prev => prev.map(i => i.id === updated.id ? updated : i));
            setSelectedIdea(updated);
          }}
          onDeleted={(id) => {
            setAllIdeas(prev => prev.filter(i => i.id !== id));
            onIdeasChange(allIdeas.filter(i => i.id !== id));
          }}
          onCreateTask={onCreateTask}
        />
      )}
    </div>
  );
}
