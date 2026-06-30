import { useState, useRef, useEffect } from "react";
import { post, get } from "@/lib/api";
import { C, F, FS, inp, btn1, btn2, lbl } from "./constants";
import { VoiceInput } from "./VoiceInput";
import { showToast } from "./Toast";
import { showTrainNowToast } from "@/lib/trainNowToast";
import type { Idea } from "./types";

const CATS = ["Tech", "Sales", "Marketing", "Strategic Partners", "Operations", "Product", "Personal"];
const URG = ["Now", "This Week", "This Month", "Someday"];
const PRIORITY_COLOR: Record<string, string> = { high: C.red, medium: C.amb, low: C.grn };

interface TeamMember { name: string; email: string | null; slackId?: string | null; source?: string; }

const ASSIGNABLE_URGENCIES = ["Now", "This Week", "This Month"];

// Default escalate-meeting slot: tomorrow at 2pm local, skipping weekends.
// Returns YYYY-MM-DDTHH:MM in LOCAL timezone (matches <input type="datetime-local"> format).
function defaultEscalateMeetingAt(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sun → Mon
  if (d.getDay() === 6) d.setDate(d.getDate() + 2); // Sat → Mon
  d.setHours(14, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Convert YYYY-MM-DDTHH:MM (local) to a friendly "Wed Apr 29 at 2:00 PM" string.
function formatMeetingAt(local: string): string {
  try {
    const d = new Date(local);
    return d.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch {
    return local;
  }
}

function getDefaultDueDate(urgency: string): string {
  const today = new Date();
  if (urgency === "Now") {
    return today.toISOString().split("T")[0];
  } else if (urgency === "This Week") {
    const dayOfWeek = today.getDay();
    const daysUntilFriday = dayOfWeek <= 5 ? 5 - dayOfWeek : 6;
    const friday = new Date(today);
    friday.setDate(today.getDate() + (daysUntilFriday === 0 && dayOfWeek === 5 ? 0 : daysUntilFriday));
    return friday.toISOString().split("T")[0];
  } else if (urgency === "This Month") {
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return lastDay.toISOString().split("T")[0];
  }
  return today.toISOString().split("T")[0];
}

interface Pushback {
  message: string;
  priorityRank: number | null;
  action: "park" | "override" | "escalate" | null;
}

interface Classification {
  category: string;
  urgency: string;
  techType: string | null;
  reason: string;
  businessFit: string;
  priority: string;
  warningIfDistraction?: string;
  pushback?: Pushback | null;
}

interface AssignState {
  mode: "none" | "team" | "custom";
  assigneeName: string;
  assigneeEmail: string;
  assigneeSlackId: string | null;
  dueDate: string;
  notifyEmail: boolean;
  notifySlack: boolean;
  note: string;
}

// Pushback variants (V3 escalate, V4 pushback-park) get a compact, OPTIONAL
// assign section: pick someone, then opt-in to notifying them per Slack/email.
// Decoupled from the existing AssignState so the urgency-gated UI for V1/V2
// stays untouched (Q2 directive).
interface PushbackAssign {
  mode: "none" | "team" | "custom";
  assigneeName: string;
  assigneeEmail: string;
  assigneeSlackId: string | null;
  notifyOn: boolean;
  notifyEmail: boolean;
  notifySlack: boolean;
}
const blankPushbackAssign = (): PushbackAssign => ({
  mode: "none", assigneeName: "", assigneeEmail: "", assigneeSlackId: null,
  notifyOn: false, notifyEmail: false, notifySlack: false,
});

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (idea: Idea) => void;
  onCreateTask?: (ideaText: string, category: string, urgency: string, techType?: string) => void;
  count: number;
}

type Step = "input" | "classifying" | "review" | "saving" | "parked";

export function IdeasModal({ open, onClose, onSave, onCreateTask, count }: Props) {
  const [text, setText] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [classification, setClassification] = useState<Classification | null>(null);
  const [overrides, setOverrides] = useState<Partial<Classification>>({});
  const [error, setError] = useState("");
  const [linearId, setLinearId] = useState<string | null>(null);
  const [pushback, setPushback] = useState<Pushback | null>(null);
  const [override, setOverride] = useState<{ justification: string } | null>(null);
  const [assign, setAssign] = useState<AssignState | null>(null);
  const [pushbackAssign, setPushbackAssign] = useState<PushbackAssign>(blankPushbackAssign());
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  // Escalate flow: meeting time (datetime-local) + whether to also open the
  // task-creation modal after parking. Defaults: tomorrow 2pm local, create-task ON.
  const [escalateMeetingAt, setEscalateMeetingAt] = useState<string>(() => defaultEscalateMeetingAt());
  const [escalateCreateTask, setEscalateCreateTask] = useState<boolean>(true);
  const [escalateConfirmation, setEscalateConfirmation] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    // Re-fetch every time the modal opens so newly seeded team_roles or Slack
    // re-mappings show up without a hard refresh.
    if (open) {
      get<{ ok: boolean; members: TeamMember[] }>("/ideas/team-members")
        .then(res => { if (res.ok && mountedRef.current) setTeamMembers(res.members); })
        .catch(() => {});
    }
  }, [open]);

  const finalCat = overrides.category ?? classification?.category ?? "Tech";
  const finalUrg = overrides.urgency ?? classification?.urgency ?? "This Week";
  const finalTt = overrides.techType ?? classification?.techType ?? null;

  const showAssign = ASSIGNABLE_URGENCIES.includes(finalUrg);

  useEffect(() => {
    if (step === "review" && classification) {
      if (ASSIGNABLE_URGENCIES.includes(finalUrg)) {
        setAssign(prev => prev ? { ...prev, dueDate: getDefaultDueDate(finalUrg) } : {
          mode: "none",
          assigneeName: "",
          assigneeEmail: "",
          assigneeSlackId: null,
          dueDate: getDefaultDueDate(finalUrg),
          notifyEmail: true,
          notifySlack: false,
          note: "",
        });
      } else {
        setAssign(null);
      }
    }
  }, [finalUrg, step, classification]);

  const reset = () => {
    setText("");
    setStep("input");
    setClassification(null);
    setOverrides({});
    setError("");
    setLinearId(null);
    setPushback(null);
    setOverride(null);
    setEscalateMeetingAt(defaultEscalateMeetingAt());
    setEscalateCreateTask(true);
    setEscalateConfirmation(null);
    setAssign(null);
    setPushbackAssign(blankPushbackAssign());
    // keep teamMembers cached — no need to reset
  };

  const handleClose = () => { reset(); onClose(); };

  // Fires /ideas/notify-assignee for the V3/V4 pushback variants when Tony
  // chose an assignee AND opted in to notifying them. No-op otherwise.
  const dispatchPushbackAssigneeNotify = (categoryArg: string, urgencyArg: string) => {
    const a = pushbackAssign;
    if (a.mode === "none" || !a.notifyOn || !a.assigneeName.trim()) return;
    const email = a.assigneeEmail.trim();
    const slackId = a.assigneeSlackId;
    const channels: string[] = [];
    if (a.notifyEmail && email) channels.push("email");
    if (a.notifySlack && slackId) channels.push("slack");
    if (channels.length === 0) return;
    post("/ideas/notify-assignee", {
      ideaText: text, category: categoryArg, urgency: urgencyArg, dueDate: "",
      assigneeName: a.assigneeName.trim(),
      assigneeEmail: email || `${a.assigneeName.trim().toLowerCase().replace(/\s+/g, ".")}@${import.meta.env.VITE_EMAIL_DOMAIN || "flipiq.com"}`,
      slackUserId: slackId || undefined,
      notifyChannels: channels,
    }).catch(() => console.warn("[Ideas] pushback assignee notify failed"));
  };

  // Compact assign section used in BOTH V3 (escalate) and V4 (pushback-park).
  // Optional — Tony only sees the notify checkbox after picking an assignee,
  // and channel toggles are gated by whether each channel is reachable.
  const renderPushbackAssign = (panelTint: string) => {
    const a = pushbackAssign;
    const hasEmail = a.assigneeEmail.trim().length > 0;
    const hasSlack = !!a.assigneeSlackId;
    const hasAssignee = a.mode !== "none" && a.assigneeName.trim().length > 0;
    return (
      <div style={{ marginTop: 12, padding: 10, background: C.card, border: `1px dashed ${panelTint}`, borderRadius: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: C.mut, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
          Assign (optional)
        </div>
        <select
          value={a.mode === "team" ? `${a.assigneeName}|${a.assigneeEmail}|${a.assigneeSlackId || ""}` : a.mode === "custom" ? "__custom__" : ""}
          onChange={e => {
            const val = e.target.value;
            if (!val) {
              setPushbackAssign({ ...blankPushbackAssign() });
            } else if (val === "__custom__") {
              setPushbackAssign({ ...blankPushbackAssign(), mode: "custom" });
            } else {
              const [name, email, slackId] = val.split("|");
              const eHas = !!email;
              const sHas = !!slackId;
              setPushbackAssign({
                mode: "team",
                assigneeName: name,
                assigneeEmail: email,
                assigneeSlackId: slackId || null,
                notifyOn: false,
                notifyEmail: eHas,
                notifySlack: !eHas && sHas,
              });
            }
          }}
          style={{ ...inp, padding: "6px 10px", fontSize: 13, cursor: "pointer", marginBottom: 8 }}
        >
          <option value="">— No assignee —</option>
          {teamMembers.map(m => (
            <option key={`${m.name}|${m.email || ""}`} value={`${m.name}|${m.email || ""}|${m.slackId || ""}`}>
              {m.name}{m.slackId ? " ✓ Slack" : ""}{m.email ? ` · ${m.email}` : " (Slack only)"}
            </option>
          ))}
          <option value="__custom__">+ Enter custom name & email...</option>
        </select>

        {a.mode === "custom" && (
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input type="text" placeholder="Name" value={a.assigneeName}
              onChange={e => setPushbackAssign({ ...a, assigneeName: e.target.value })}
              style={{ ...inp, padding: "6px 10px", fontSize: 13, flex: 1 }} />
            <input type="email" placeholder="email@example.com" value={a.assigneeEmail}
              onChange={e => setPushbackAssign({ ...a, assigneeEmail: e.target.value })}
              style={{ ...inp, padding: "6px 10px", fontSize: 13, flex: 1 }} />
          </div>
        )}

        {hasAssignee && (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.sub, cursor: "pointer", marginBottom: a.notifyOn ? 8 : 0 }}>
              <input type="checkbox" checked={a.notifyOn}
                onChange={e => setPushbackAssign({ ...a, notifyOn: e.target.checked })}
                style={{ accentColor: panelTint, cursor: "pointer" }} />
              Send notification to assignee
            </label>
            {a.notifyOn && (
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => hasEmail && setPushbackAssign({ ...a, notifyEmail: !a.notifyEmail })}
                  disabled={!hasEmail}
                  title={!hasEmail ? "No email address for this person" : ""}
                  style={{
                    padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: F,
                    cursor: hasEmail ? "pointer" : "not-allowed",
                    border: `2px solid ${a.notifyEmail && hasEmail ? C.blu : C.brd}`,
                    background: a.notifyEmail && hasEmail ? C.bluBg : C.card,
                    color: a.notifyEmail && hasEmail ? C.blu : hasEmail ? C.sub : C.mut,
                    opacity: hasEmail ? 1 : 0.45,
                  }}
                >📧 Email</button>
                <button
                  type="button"
                  onClick={() => hasSlack && setPushbackAssign({ ...a, notifySlack: !a.notifySlack })}
                  disabled={!hasSlack}
                  title={!hasSlack ? "No Slack ID for this person" : ""}
                  style={{
                    padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: F,
                    cursor: hasSlack ? "pointer" : "not-allowed",
                    border: `2px solid ${a.notifySlack && hasSlack ? "#1D9353" : C.brd}`,
                    background: a.notifySlack && hasSlack ? "#E8F5E9" : C.card,
                    color: a.notifySlack && hasSlack ? "#1D9353" : hasSlack ? C.sub : C.mut,
                    opacity: hasSlack ? 1 : 0.45,
                  }}
                >💬 Slack {hasSlack ? "✓" : ""}</button>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const classify = async () => {
    if (!text.trim()) return;
    setStep("classifying");
    setError("");
    setPushback(null);
    setOverride(null);
    try {
      const res = await post<{ ok: boolean; classification: Classification }>("/ideas/classify", { text });
      setClassification(res.classification);
      setOverrides({});
      if (res.classification.pushback) {
        setPushback(res.classification.pushback);
      }
      setStep("review");
    } catch {
      setError("Couldn't classify — please set category manually.");
      setClassification({ category: "Operations", urgency: "This Week", techType: null, reason: "", businessFit: "", priority: "medium" });
      setStep("review");
    }
  };

  const save = async () => {
    setStep("saving");
    setError("");
    try {
      // Validate custom email format BEFORE backend rejects it.
      const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (assign && assign.mode === "custom" && assign.assigneeEmail.trim() && !emailRx.test(assign.assigneeEmail.trim())) {
        setError("That email doesn't look right. Use the format name@domain.com.");
        setStep("review");
        return;
      }

      const trimmedName = assign?.assigneeName.trim() || "";
      const trimmedEmail = assign?.assigneeEmail.trim() || "";
      const hasSlackOnly = !!(assign && assign.mode !== "none" && trimmedName && !trimmedEmail && assign.assigneeSlackId);
      const hasAssignee = !!(assign && assign.mode !== "none" && trimmedName && (trimmedEmail || hasSlackOnly));
      const assigneeName = hasAssignee ? trimmedName : undefined;
      // Backend zod requires email format if email is sent. Skip the field for Slack-only.
      const assigneeEmail = hasAssignee && trimmedEmail ? trimmedEmail : undefined;
      const dueDate = hasAssignee ? assign!.dueDate || undefined : undefined;

      const idea = await post<Idea & { linearIssue?: { identifier: string } | null }>("/ideas", {
        text,
        category: finalCat,
        urgency: finalUrg,
        techType: finalTt || undefined,
        aiReflection: classification ? JSON.stringify(classification) : undefined,
        ...(assigneeName ? { assigneeName, ...(assigneeEmail ? { assigneeEmail } : {}), dueDate } : {}),
      });

      // Notify assignee per checked channels — fires regardless of urgency
      // (including Someday) per Q2: assignees should be notified whenever
      // Tony picked them, not gated by urgency.
      if (hasAssignee && assigneeName) {
        const notifyChannels: string[] = [];
        if (assign?.notifyEmail && assigneeEmail) notifyChannels.push("email");
        if (assign?.notifySlack && assign?.assigneeSlackId) notifyChannels.push("slack");
        if (notifyChannels.length > 0) {
          post("/ideas/notify-assignee", {
            ideaText: text, category: finalCat, urgency: finalUrg, dueDate: dueDate || "",
            assigneeName,
            assigneeEmail: assigneeEmail || `${assigneeName.toLowerCase().replace(/\s+/g, ".")}@${import.meta.env.VITE_EMAIL_DOMAIN || "flipiq.com"}`,
            slackUserId: assign?.assigneeSlackId || undefined,
            notifyChannels, note: assign!.note || undefined,
          }).catch(() => console.warn("[Ideas] Failed to send assignee notification"));
        }
      }

      if (idea.linearIssue?.identifier) {
        setLinearId(idea.linearIssue.identifier);
        await new Promise<void>(resolve => {
          const t = setTimeout(() => resolve(), 2000);
          if (!mountedRef.current) { clearTimeout(t); resolve(); }
        });
      }

      // Q1 (uniform): every variant DMs Ethan directly. This branch covers
      // Variants 1 (Tech) + 2 (Normal park). Pushback Variants 3/4 have
      // their own dedicated paths (escalate-to-ethan / pushback Park-It
      // button below) that already DM him. Tech ALSO gets a #tech-ideas
      // channel post server-side from POST /ideas — the DM is additive.
      if (!pushback) {
        const parkRes = await post<{ ok: boolean; feedback_id?: string }>("/ideas/notify-park", {
          text, category: finalCat, urgency: finalUrg, ideaId: idea.id,
        }).catch(err => { console.warn("[Ideas] notify-park failed:", err); return null; });
        showTrainNowToast({
          agent: "ideas",
          feedbackId: parkRes?.feedback_id ?? null,
          sourceId: idea.id,
          title: finalCat === "Tech" ? "Tech idea parked" : "Idea parked",
          description: finalCat === "Tech"
            ? "Posted to #engineering · Train the ideas agent?"
            : "Ethan notified · Train the ideas agent on this park?",
        });
      } else {
        showToast({ title: "Idea saved" });
      }

      onSave(idea);
      // Only open task creation modal if urgency is NOT Someday
      if (onCreateTask && finalUrg !== "Someday") {
        // Must await so reset/onClose don't race the async task creation
        await onCreateTask(text, finalCat, finalUrg, finalTt ?? undefined);
      }
      reset();
      onClose();
    } catch (err: any) {
      // Surface the backend error message when available so the user knows
      // what to fix (e.g. invalid email format).
      const msg = (err?.message && err.message !== "Failed to fetch") ? err.message : "Failed to save idea. Please try again.";
      setError(msg.slice(0, 200));
      setStep("review");
    }
  };

  if (!open) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={handleClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 18, width: 520, maxWidth: "92vw", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 28, overflowY: "auto", flex: 1 }}>

        {/* ── STEP 1: Input ── */}
        {step === "input" && (
          <>
            <h3 style={{ fontFamily: FS, fontSize: 20, margin: "0 0 4px" }}>What's your brilliant idea?</h3>
            <p style={{ fontSize: 13, color: C.mut, margin: "0 0 16px" }}>That'll be #{count + 1} — {count} parked ahead of it. AI will classify it.</p>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 14 }}>
              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="Speak or type your idea..."
                autoFocus
                onKeyDown={e => { if (e.key === "Enter" && e.metaKey) classify(); }}
                style={{ ...inp, minHeight: 80, resize: "vertical", flex: 1 }}
              />
              <VoiceInput onTranscript={t => setText(prev => prev ? prev + " " + t : t)} size={34} />
            </div>
            {error && <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: C.redBg, color: C.red, fontSize: 12 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleClose} style={{ ...btn2, flex: 1 }}>Cancel</button>
              <button onClick={classify} disabled={!text.trim()} style={{ ...btn1, flex: 2, opacity: !text.trim() ? 0.5 : 1 }}>
                Classify It → (⌘↵)
              </button>
            </div>
          </>
        )}

        {/* ── STEP 2: Classifying ── */}
        {step === "classifying" && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🧠</div>
            <div style={{ fontFamily: FS, fontSize: 18, marginBottom: 8 }}>Classifying your idea...</div>
            <div style={{ fontSize: 13, color: C.mut }}>Checking against FlipIQ business priorities</div>
          </div>
        )}

        {/* ── STEP 3: Review AI classification ── */}
        {step === "review" && classification && (
          <>
            <h3 style={{ fontFamily: FS, fontSize: 20, margin: "0 0 4px" }}>AI Classified Your Idea</h3>
            <p style={{ fontSize: 12, color: C.mut, margin: "0 0 16px" }}>Review and override if needed, then park it.</p>

            {/* Idea text */}
            <div style={{ padding: "10px 14px", background: "#F8F8F6", borderRadius: 10, fontSize: 14, marginBottom: 16, fontStyle: "italic", color: C.sub }}>
              "{text}"
            </div>

            {/* AI reasoning */}
            <div style={{ padding: "12px 14px", background: "#F8F8F6", border: `1px solid ${C.brd}`, borderRadius: 10, marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: C.mut, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                AI Analysis
              </div>
              <div style={{ fontSize: 13, color: C.tx, marginBottom: 4 }}>
                <strong>Why {classification.category}:</strong> {classification.reason}
              </div>
              <div style={{ fontSize: 13, color: C.tx, marginBottom: classification.warningIfDistraction ? 4 : 0 }}>
                <strong>Business fit:</strong> {classification.businessFit}
              </div>
              {classification.warningIfDistraction && (
                <div style={{ fontSize: 12, color: C.amb, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.brd}` }}>
                  ⚠️ {classification.warningIfDistraction}
                </div>
              )}
              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: C.mut }}>AI priority:</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: PRIORITY_COLOR[classification.priority] || C.mut, textTransform: "uppercase" }}>
                  {classification.priority}
                </span>
              </div>
            </div>

            {/* ── PUSHBACK: Escalate (unreasonable) ── */}
            {pushback && pushback.action === "escalate" && (
              <div style={{ padding: 16, background: C.redBg, borderRadius: 10, marginBottom: 14, border: `1px solid ${C.red}` }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: C.red, marginBottom: 8 }}>🚨 Scope Check</div>
                <div style={{ fontSize: 13, color: C.tx, marginBottom: 12 }}>{pushback.message}</div>

                {/* Meeting time picker — Tony can change the slot before booking */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ ...lbl, marginBottom: 4 }}>Meeting with Ethan</label>
                  <input
                    type="datetime-local"
                    value={escalateMeetingAt}
                    onChange={e => setEscalateMeetingAt(e.target.value)}
                    style={{ ...inp, padding: "6px 10px", fontSize: 13 }}
                  />
                  <div style={{ fontSize: 10, color: C.mut, marginTop: 4 }}>
                    Default tomorrow at 2pm. Calendar invite sent to {import.meta.env.VITE_ACCOUNTABILITY_EMAIL || "ethan@flipiq.com"}.
                  </div>
                </div>

                <button
                  onClick={async () => {
                    setStep("saving");
                    try {
                      const idea = await post<Idea>("/ideas", { text, category: finalCat, urgency: "Someday" });

                      // Build start/end ISO strings from the chosen local datetime.
                      const startLocal = escalateMeetingAt || defaultEscalateMeetingAt();
                      const startDate = new Date(startLocal);
                      const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

                      // Always notify Ethan when this button is clicked (matches the label).
                      // Pass ideaId/category/urgency so the backend can record an
                      // 'escalate' feedback row (B5-4) with full snapshot context.
                      type EscalateRes = { ok: boolean; meetingStart?: string; meetingEnd?: string; calendarOk?: boolean; slackOk?: boolean; feedback_id?: string };
                      const r: EscalateRes = await post<EscalateRes>("/ideas/escalate-to-ethan", {
                        text,
                        rank: pushback.priorityRank,
                        meetingStart: startDate.toISOString(),
                        meetingEnd: endDate.toISOString(),
                        ideaId: idea.id,
                        category: finalCat,
                        urgency: finalUrg,
                        reasoning: pushback.message || null,
                      }).catch(() => ({ ok: false } as EscalateRes));

                      // Confirmation string for the saving step UX.
                      const friendly = formatMeetingAt(startLocal);
                      setEscalateConfirmation(
                        r.ok && r.calendarOk !== false
                          ? `Ethan booked for ${friendly} — calendar invite sent.`
                          : `Idea parked. Ethan notified on Slack (calendar booking failed).`
                      );

                      showTrainNowToast({
                        agent: "ideas",
                        feedbackId: r.feedback_id ?? null,
                        sourceId: idea.id,
                        title: "Idea escalated to Ethan",
                        description: r.ok && r.calendarOk !== false
                          ? `Meeting booked for ${friendly} · Train the ideas agent?`
                          : "Slack sent · Train the ideas agent on this escalation?",
                      });

                      // V3 optional assignee notification — fires when Tony
                      // picked someone in the assign section AND opted in.
                      dispatchPushbackAssigneeNotify(finalCat, finalUrg);

                      onSave(idea);

                      // Brief pause so Tony can read the confirmation, then either
                      // open the task modal (if checked) or just close.
                      await new Promise<void>(resolve => {
                        const t = setTimeout(() => resolve(), 1800);
                        if (!mountedRef.current) { clearTimeout(t); resolve(); }
                      });

                      if (escalateCreateTask && onCreateTask) {
                        await onCreateTask(text, finalCat, finalUrg, finalTt ?? undefined);
                      }
                      handleClose();
                    } catch {
                      setError("Failed to park idea");
                      setStep("review");
                      showToast({ title: "Failed to park idea", variant: "error" });
                    }
                  }}
                  style={{ ...btn2, width: "100%", color: C.red, borderColor: C.red }}
                >
                  OK, Park It + Notify Ethan
                </button>

                {renderPushbackAssign(C.red)}

                {/* "Also create a task" — defaults ON. Lets Tony park the idea
                    AND drop a placeholder task into the master list so the work
                    isn't lost while waiting on Ethan's review. */}
                <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={escalateCreateTask}
                    onChange={e => setEscalateCreateTask(e.target.checked)}
                    style={{ marginTop: 2, accentColor: "#F97316", cursor: "pointer" }}
                  />
                  <span style={{ fontSize: 11, color: C.sub, lineHeight: 1.4 }}>
                    Also open the task creation modal after parking
                    <div style={{ fontSize: 10, color: C.mut, marginTop: 1 }}>
                      Off = park-only (idea is saved, you stay focused on the current view).
                    </div>
                  </span>
                </label>
              </div>
            )}

            {/* ── PUSHBACK: Park (conflicts with plan) ── */}
            {pushback && pushback.action === "park" && !override && (
              <div style={{ padding: 16, background: C.ambBg, borderRadius: 10, marginBottom: 14, border: `1px solid ${C.amb}` }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: C.amb, marginBottom: 8 }}>⚠️ Pushback</div>
                <div style={{ fontSize: 13, color: C.tx, marginBottom: 12 }}>{pushback.message}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={async () => {
                      setStep("saving");
                      try {
                        const idea = await post<Idea>("/ideas", { text, category: finalCat, urgency: "Someday" });
                        // Notify Ethan via Slack DM that Tony parked despite pushback.
                        const parkRes = await post<{ ok: boolean; feedback_id?: string }>("/ideas/notify-park", {
                          text, category: finalCat, urgency: "Someday", ideaId: idea.id,
                        }).catch(err => { console.warn("[Ideas] notify-park failed:", err); return null; });
                        // V4 optional assignee notification.
                        dispatchPushbackAssigneeNotify(finalCat, "Someday");
                        showTrainNowToast({
                          agent: "ideas",
                          feedbackId: parkRes?.feedback_id ?? null,
                          sourceId: idea.id,
                          title: "Idea parked despite pushback",
                          description: "Ethan notified · Train the ideas agent on this park?",
                        });
                        onSave(idea);
                        handleClose();
                      } catch {
                        setError("Failed to park idea");
                        setStep("review");
                        showToast({ title: "Failed to park idea", variant: "error" });
                      }
                    }}
                    style={{ ...btn2, flex: 1, color: C.amb, borderColor: C.amb }}
                  >
                    Park It
                  </button>
                  <button
                    onClick={() => { setOverride({ justification: "" }); setPushback(null); }}
                    style={{ ...btn1, flex: 1, background: C.red }}
                  >
                    Override — Do It Anyway
                  </button>
                </div>
                {renderPushbackAssign(C.amb)}
              </div>
            )}

            {/* ── OVERRIDE: Justification required ── */}
            {override && (
              <div style={{ padding: 16, background: C.redBg, borderRadius: 10, marginBottom: 14, border: `1px solid ${C.red}` }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: C.red, marginBottom: 8 }}>
                  Why should this jump the queue?
                </div>
                <textarea
                  value={override.justification}
                  onChange={e => setOverride({ justification: e.target.value })}
                  placeholder="Explain why this is urgent enough to override the plan..."
                  style={{ ...inp, minHeight: 60, resize: "vertical", marginBottom: 8 }}
                />
                <button
                  onClick={async () => {
                    setStep("saving");
                    try {
                      const idea = await post<Idea>("/ideas", { text, category: finalCat, urgency: finalUrg });
                      const ovRes = await post<{ ok: boolean; feedback_id?: string }>("/ideas/notify-override", {
                        text, justification: override.justification, ideaId: idea.id,
                      }).catch(() => null);
                      showTrainNowToast({
                        agent: "ideas",
                        feedbackId: ovRes?.feedback_id ?? null,
                        sourceId: idea.id,
                        title: "Override confirmed",
                        description: "#engineering + Ethan notified · Train the ideas agent on this override?",
                      });
                      onSave(idea);
                      if (onCreateTask) await onCreateTask(text, finalCat, finalUrg, finalTt ?? undefined);
                      handleClose();
                    } catch {
                      setError("Failed to save idea");
                      setStep("review");
                      showToast({ title: "Failed to save override", variant: "error" });
                    }
                  }}
                  disabled={!override.justification.trim()}
                  style={{ ...btn1, width: "100%", opacity: override.justification.trim() ? 1 : 0.4 }}
                >
                  Confirm Override + Notify Leadership
                </button>
              </div>
            )}

            {/* Category override */}
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Category {overrides.category && overrides.category !== classification.category ? "(overridden)" : "(AI suggestion)"}</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {CATS.map(c => (
                  <button key={c} onClick={() => setOverrides(o => ({ ...o, category: c }))}
                    style={{
                      padding: "5px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: F,
                      border: `1px solid ${finalCat === c ? "#F97316" : C.brd}`,
                      background: finalCat === c ? "#F97316" : C.card,
                      color: finalCat === c ? "#fff" : C.sub,
                    }}>
                    {c === classification.category && finalCat !== c ? `✓ ${c}` : c}
                  </button>
                ))}
              </div>
            </div>

            {/* Urgency override */}
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Urgency {overrides.urgency && overrides.urgency !== classification.urgency ? "(overridden)" : "(AI suggestion)"}</label>
              <div style={{ display: "flex", gap: 5 }}>
                {URG.map(u => (
                  <button key={u} onClick={() => setOverrides(o => ({ ...o, urgency: u }))}
                    style={{
                      padding: "5px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: F,
                      border: `1px solid ${finalUrg === u ? "#F97316" : C.brd}`,
                      background: finalUrg === u ? "#F97316" : C.card,
                      color: finalUrg === u ? "#fff" : C.sub,
                    }}>
                    {u}
                  </button>
                ))}
              </div>
            </div>

            {/* Tech type override if applicable */}
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Type (Manual Override)</label>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {["Bug", "Feature", "Note", "Task", "Strategic"].map(t => (
                  <button key={t} onClick={() => setOverrides(o => ({ ...o, techType: t }))}
                    style={{
                      padding: "5px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: F,
                      border: `1px solid ${finalTt === t ? "#F97316" : C.brd}`,
                      background: finalTt === t ? "#F97316" : C.card,
                      color: finalTt === t ? "#fff" : C.sub,
                    }}>
                    {t}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: C.mut, marginTop: 4 }}>
                {finalTt === "Task" ? "Task ideas check against the 90-day plan." : finalTt === "Strategic" ? "Strategic ideas are flagged for Ethan review." : finalTt === "Note" ? "Notes are parked for reference — not tied to a project." : finalCat === "Tech" ? "Tech ideas auto-create a Linear issue." : "Override the AI-detected type if needed."}
              </div>
            </div>

            {/* ── ASSIGN SECTION (only for Now / This Week / This Month) ── */}
            {showAssign && !pushback && !override && assign && (
              <div style={{ padding: "14px 16px", background: "#F9FAFB", border: `1px solid ${C.brd}`, borderRadius: 12, marginBottom: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: C.mut, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                  Assign (optional)
                </div>

                {/* Team member dropdown or "Custom" mode toggle */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ ...lbl, marginBottom: 4 }}>
                    Team member {teamMembers.length > 0 ? <span style={{ color: C.grn, fontWeight: 400 }}>({teamMembers.length} from Linear/Slack)</span> : <span style={{ color: C.mut, fontWeight: 400 }}>loading...</span>}
                  </label>
                  <select
                    value={assign.mode === "team" ? `${assign.assigneeName}|${assign.assigneeEmail}|${assign.assigneeSlackId || ""}` : assign.mode === "custom" ? "__custom__" : ""}
                    onChange={e => {
                      const val = e.target.value;
                      if (!val) {
                        setAssign(a => a ? { ...a, mode: "none", assigneeName: "", assigneeEmail: "", assigneeSlackId: null, notifyEmail: true, notifySlack: false } : a);
                      } else if (val === "__custom__") {
                        setAssign(a => a ? { ...a, mode: "custom", assigneeName: "", assigneeEmail: "", assigneeSlackId: null, notifyEmail: true, notifySlack: false } : a);
                      } else {
                        const [name, email, slackId] = val.split("|");
                        const hasEmail = !!email;
                        const hasSlack = !!slackId;
                        setAssign(a => a ? {
                          ...a,
                          mode: "team",
                          assigneeName: name,
                          assigneeEmail: email,
                          assigneeSlackId: slackId || null,
                          // Default the notify channels to whichever is available.
                          notifyEmail: hasEmail,
                          notifySlack: !hasEmail && hasSlack ? true : a.notifySlack,
                        } : a);
                      }
                    }}
                    style={{ ...inp, padding: "6px 10px", fontSize: 13, cursor: "pointer" }}
                  >
                    <option value="">— No assignee —</option>
                    {teamMembers.map(m => (
                      <option key={`${m.name}|${m.email || ""}`} value={`${m.name}|${m.email || ""}|${m.slackId || ""}`}>
                        {m.name}{m.slackId ? " ✓ Slack" : ""}{m.email ? ` · ${m.email}` : " (Slack only)"}
                      </option>
                    ))}
                    <option value="__custom__">+ Enter custom name & email...</option>
                  </select>
                </div>

                {/* Custom name + email inputs */}
                {assign.mode === "custom" && (
                  <div style={{ marginBottom: 10, display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ ...lbl, marginBottom: 4 }}>Name</label>
                      <input
                        type="text"
                        value={assign.assigneeName}
                        onChange={e => setAssign(a => a ? { ...a, assigneeName: e.target.value } : a)}
                        placeholder="Full name"
                        style={{ ...inp, padding: "6px 10px", fontSize: 13 }}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ ...lbl, marginBottom: 4 }}>Email</label>
                      <input
                        type="email"
                        value={assign.assigneeEmail}
                        onChange={e => setAssign(a => a ? { ...a, assigneeEmail: e.target.value } : a)}
                        placeholder="email@example.com"
                        style={{ ...inp, padding: "6px 10px", fontSize: 13 }}
                      />
                    </div>
                  </div>
                )}

                {/* Target date, note, notify — shown when a valid assignee is selected */}
                {assign.mode !== "none" && (
                  <>
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ ...lbl, marginBottom: 4 }}>Target date</label>
                      <input
                        type="date"
                        value={assign.dueDate}
                        onChange={e => setAssign(a => a ? { ...a, dueDate: e.target.value } : a)}
                        style={{ ...inp, padding: "6px 10px", fontSize: 13 }}
                      />
                    </div>

                    <div style={{ marginBottom: 10 }}>
                      <label style={{ ...lbl, marginBottom: 4 }}>Note (optional)</label>
                      <input
                        type="text"
                        value={assign.note}
                        onChange={e => setAssign(a => a ? { ...a, note: e.target.value } : a)}
                        placeholder="Any context or instructions..."
                        style={{ ...inp, padding: "6px 10px", fontSize: 13 }}
                      />
                    </div>

                    <div>
                      <label style={{ ...lbl, marginBottom: 6 }}>Notify via</label>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => assign.assigneeEmail.trim() && setAssign(a => a ? { ...a, notifyEmail: !a.notifyEmail } : a)}
                          disabled={!assign.assigneeEmail.trim()}
                          title={!assign.assigneeEmail.trim() ? "No email address for this person" : ""}
                          style={{
                            padding: "5px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: assign.assigneeEmail.trim() ? "pointer" : "not-allowed", fontFamily: F,
                            border: `2px solid ${assign.notifyEmail ? C.blu : C.brd}`,
                            background: assign.notifyEmail ? C.bluBg : C.card,
                            color: assign.notifyEmail ? C.blu : assign.assigneeEmail.trim() ? C.sub : C.mut,
                            opacity: !assign.assigneeEmail.trim() ? 0.45 : 1,
                          }}
                        >
                          📧 Email
                        </button>
                        <button
                          onClick={() => setAssign(a => a ? { ...a, notifySlack: !a.notifySlack } : a)}
                          disabled={!assign.assigneeSlackId}
                          title={!assign.assigneeSlackId ? "No Slack account linked for this person" : ""}
                          style={{
                            padding: "5px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: assign.assigneeSlackId ? "pointer" : "not-allowed", fontFamily: F,
                            border: `2px solid ${assign.notifySlack ? "#1D9353" : C.brd}`,
                            background: assign.notifySlack ? "#E8F5E9" : C.card,
                            color: assign.notifySlack ? "#1D9353" : assign.assigneeSlackId ? C.sub : C.mut,
                            opacity: !assign.assigneeSlackId ? 0.45 : 1,
                          }}
                        >
                          💬 Slack {assign.assigneeSlackId ? "✓" : ""}
                        </button>
                      </div>
                      {!assign.assigneeSlackId && assign.mode === "team" && assign.assigneeEmail.trim() && (
                        <div style={{ fontSize: 10, color: C.mut, marginTop: 4 }}>No Slack account linked — email only</div>
                      )}
                      {!assign.assigneeEmail.trim() && assign.assigneeSlackId && (
                        <div style={{ fontSize: 10, color: C.mut, marginTop: 4 }}>No email — Slack only</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {error && <div style={{ marginBottom: 4, padding: "8px 12px", borderRadius: 8, background: C.redBg, color: C.red, fontSize: 12 }}>{error}</div>}
          </>
        )}

        {/* ── STEP 4: Saving / confirmation ── */}
        {step === "saving" && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>
              {escalateConfirmation ? "📅" : linearId ? "✅" : "⏳"}
            </div>
            <div style={{ fontFamily: FS, fontSize: 18, marginBottom: 8 }}>
              {escalateConfirmation
                ? "Idea Parked + Ethan Notified"
                : linearId
                ? `${finalUrg === "Now" ? "Posted!" : "Parked!"} Linear: ${linearId}`
                : finalUrg === "Now"
                ? "Posting and delivering..."
                : "Parking your idea..."}
            </div>
            {escalateConfirmation && (
              <div style={{ fontSize: 13, color: C.grn, padding: "0 24px", lineHeight: 1.5 }}>
                {escalateConfirmation}
              </div>
            )}
            {!escalateConfirmation && linearId && (
              <div style={{ fontSize: 13, color: C.grn }}>
                {finalUrg === "Now" ? "Delivered now — action item live." : "Tech idea sent to Linear — back to calls!"}
              </div>
            )}
            {!escalateConfirmation && !linearId && (
              <div style={{ fontSize: 13, color: C.mut }}>Saving to database...</div>
            )}
          </div>
        )}

        {/* ── STEP: Parked — task creation is automatic, just show confirmation ── */}
        {step === "parked" && (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📌</div>
            <div style={{ fontFamily: FS, fontSize: 18, marginBottom: 8 }}>Idea Parked</div>
            <div style={{ fontSize: 13, color: C.mut, marginBottom: 20 }}>Opening task creation…</div>
          </div>
        )}

      </div>{/* end scrollable body */}

      {/* ── STICKY FOOTER: action buttons (only on review step, no pushback/override in progress) ── */}
      {step === "review" && classification && !pushback && !override && (
        <div style={{ padding: "14px 28px", borderTop: `1px solid ${C.brd}`, background: C.card, borderRadius: "0 0 18px 18px", flexShrink: 0 }}>
          <button onClick={save} style={{ ...btn1, width: "100%", marginBottom: 8, ...(finalUrg === "Now" ? { background: "#B71C1C" } : {}), padding: "12px 20px", fontSize: 15 }}>
            {(() => {
              const hasAssignee = assign && assign.mode !== "none" && assign.assigneeName.trim() && assign.assigneeEmail.trim();
              const willNotify = hasAssignee && (assign!.notifyEmail || (assign!.notifySlack && assign!.assigneeSlackId));
              if (finalUrg === "Now") return willNotify ? "Post and Deliver →" : "Post Now →";
              if (willNotify) return "Park & Notify Assignee →";
              return "Park It → Back to Calls";
            })()}
          </button>
          <button onClick={() => setStep("input")} style={{ ...btn2, width: "100%", fontSize: 13 }}>← Edit Idea</button>
        </div>
      )}

      </div>
    </div>
  );
}
