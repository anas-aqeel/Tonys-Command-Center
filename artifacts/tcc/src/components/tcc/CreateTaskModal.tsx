import { useState, useRef, useEffect } from "react";
import { post } from "@/lib/api";
import { C, F, FS, inp, btn1, btn2, lbl } from "./constants";
import { showTrainNowToast } from "@/lib/trainNowToast";

interface HigherPriorityItem {
  id: string;
  text: string;
  source: "linear" | "local";
  priority?: number;
}

interface PriorityCheck {
  hasHigherPriority: boolean;
  count: number;
  items: HigherPriorityItem[];
  newTaskPriority: number;
}

interface SavedTask {
  id: string;
  text: string;
  dueDate?: string;
  priority?: number;
  status?: string;
  createdAt?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (task: SavedTask) => void;
}

type Step = "input" | "checking" | "review" | "pushback" | "saving";

type TaskType = "one_time" | "ongoing";
type TaskSize = "XS" | "S" | "M" | "L" | "XL";

export function CreateTaskModal({ open, onClose, onSave }: Props) {
  const [text, setText] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("one_time");
  const [size, setSize] = useState<TaskSize | null>(null);
  const [step, setStep] = useState<Step>("input");
  const [priorityCheck, setPriorityCheck] = useState<PriorityCheck | null>(null);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reset = () => {
    setText("");
    setDueDate("");
    setTaskType("one_time");
    setSize(null);
    setStep("input");
    setPriorityCheck(null);
    setError("");
  };

  const handleClose = () => { reset(); onClose(); };

  const checkPriority = async () => {
    if (!text.trim()) return;
    setStep("checking");
    setError("");
    try {
      const res = await post<{ ok: boolean; priorityCheck: PriorityCheck }>("/tasks/create-with-check", {
        text: text.trim(),
        dueDate: dueDate || undefined,
        checkOnly: true,
        taskType,
        size: size ?? undefined,
      });
      setPriorityCheck(res.priorityCheck);
      if (res.priorityCheck.hasHigherPriority) {
        setStep("pushback");
      } else {
        setStep("review");
      }
    } catch {
      setError("Couldn't check priority — saving anyway.");
      setPriorityCheck(null);
      setStep("review");
    }
  };

  const save = async (overrideWarning?: string) => {
    setStep("saving");
    setError("");
    try {
      const task = await post<SavedTask & { feedback_id?: string }>("/tasks/create-with-check", {
        text: text.trim(),
        dueDate: dueDate || undefined,
        overrideWarning,
        taskType,
        size: size ?? undefined,
      });
      // If user just proceeded past a priority warning, that's a feedback row
      // — surface the Train-now toast so Coach can learn from the override.
      if (overrideWarning) {
        showTrainNowToast({
          agent: "tasks",
          feedbackId: task.feedback_id ?? null,
          sourceId: task.id,
          title: "Task created (priority override logged)",
          description: "Train the tasks agent on this override?",
        });
      }
      if (mountedRef.current) {
        onSave(task);
        reset();
        onClose();
      }
    } catch {
      setError("Failed to save task. Please try again.");
      setStep(priorityCheck?.hasHigherPriority ? "pushback" : "review");
    }
  };

  if (!open) return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={handleClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: C.card, borderRadius: 18, padding: 28, width: 520, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" }}
      >

        {/* ── STEP 1: Input ── */}
        {step === "input" && (
          <>
            <h3 style={{ fontFamily: FS, fontSize: 20, margin: "0 0 4px" }}>New Task</h3>
            <p style={{ fontSize: 13, color: C.mut, margin: "0 0 16px" }}>Add a task with a due date. AI will check it against your priority queue.</p>

            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>Task</label>
              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="What needs to get done?"
                autoFocus
                onKeyDown={e => { if (e.key === "Enter" && e.metaKey) checkPriority(); }}
                style={{ ...inp, minHeight: 80, resize: "vertical" }}
              />
            </div>

            {/* Type toggle */}
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Task Type</label>
              <div style={{ display: "flex", gap: 0, borderRadius: 10, overflow: "hidden", border: `1px solid ${C.brd}` }}>
                {(["one_time", "ongoing"] as TaskType[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setTaskType(t)}
                    style={{
                      flex: 1, padding: "9px 0", fontSize: 13, fontWeight: 700, fontFamily: "inherit",
                      border: "none", cursor: "pointer",
                      background: taskType === t ? (t === "ongoing" ? C.blu : C.tx) : C.card,
                      color: taskType === t ? (t === "ongoing" ? "#fff" : C.bg) : C.sub,
                      transition: "all 0.15s",
                    }}
                  >
                    {t === "one_time" ? "✓ One Time" : "↻ Ongoing"}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: C.mut, marginTop: 5 }}>
                {taskType === "ongoing" ? "This task repeats — it won't disappear when checked off." : "This task gets done once and is removed."}
              </div>
            </div>

            {/* Shirt size */}
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Effort Size <span style={{ fontWeight: 400, color: C.mut }}>(optional)</span></label>
              <div style={{ display: "flex", gap: 6 }}>
                {(["XS", "S", "M", "L", "XL"] as TaskSize[]).map(s => {
                  const isSelected = size === s;
                  const sizeColor = s === "XL" ? C.red : s === "L" ? C.blu : s === "M" ? C.grn : C.sub;
                  return (
                    <button
                      key={s}
                      onClick={() => setSize(isSelected ? null : s)}
                      style={{
                        flex: 1, padding: "8px 0", fontSize: 12, fontWeight: 800, fontFamily: "inherit",
                        borderRadius: 8, border: `2px solid ${isSelected ? sizeColor : C.brd}`,
                        cursor: "pointer",
                        background: isSelected ? sizeColor + "22" : C.card,
                        color: isSelected ? sizeColor : C.sub,
                        transition: "all 0.1s",
                      }}
                    >{s}</button>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: C.mut, marginTop: 5 }}>
                XS = 15 min · S = 1 hr · M = half day · L = full day · XL = multi-day
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Due Date <span style={{ fontWeight: 400, color: C.mut }}>(optional)</span></label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                style={{ ...inp, cursor: "pointer" }}
              />
            </div>

            {error && (
              <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: C.redBg, color: C.red, fontSize: 12 }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleClose} style={{ ...btn2, flex: 1 }}>Cancel</button>
              <button
                onClick={checkPriority}
                disabled={!text.trim()}
                style={{ ...btn1, flex: 2, opacity: !text.trim() ? 0.5 : 1 }}
              >
                Check Priority → (⌘↵)
              </button>
            </div>
          </>
        )}

        {/* ── STEP 2: Checking ── */}
        {step === "checking" && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🧠</div>
            <div style={{ fontFamily: FS, fontSize: 18, marginBottom: 8 }}>Checking priority queue...</div>
            <div style={{ fontSize: 13, color: C.mut }}>Comparing against your active tasks and Linear issues</div>
          </div>
        )}

        {/* ── STEP 3: Review (no conflicts) ── */}
        {step === "review" && (
          <>
            <h3 style={{ fontFamily: FS, fontSize: 20, margin: "0 0 4px" }}>Looks Good</h3>
            <p style={{ fontSize: 12, color: C.mut, margin: "0 0 16px" }}>No higher-priority conflicts found. Ready to save.</p>

            <div style={{ padding: "10px 14px", background: "#F8F8F6", borderRadius: 10, fontSize: 14, marginBottom: 12, fontStyle: "italic", color: C.sub }}>
              "{text}"
            </div>

            {dueDate && (
              <div style={{ padding: "8px 14px", background: C.grnBg, border: `1px solid ${C.grn}30`, borderRadius: 10, marginBottom: 16, fontSize: 13, color: C.grn }}>
                Due: {new Date(dueDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </div>
            )}

            <div style={{ padding: "12px 14px", background: C.grnBg, border: `1px solid ${C.grn}30`, borderRadius: 10, marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.grn, textTransform: "uppercase", letterSpacing: 1 }}>
                Priority Check Passed
              </div>
              <div style={{ fontSize: 13, color: C.tx, marginTop: 4 }}>
                No higher-priority tasks are blocking this.
              </div>
            </div>

            {error && (
              <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: C.redBg, color: C.red, fontSize: 12 }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setStep("input")} style={{ ...btn2, flex: 1 }}>← Edit</button>
              <button onClick={() => save()} style={{ ...btn1, flex: 2 }}>Save Task</button>
            </div>
          </>
        )}

        {/* ── STEP 4: Pushback (higher-priority conflicts) ── */}
        {step === "pushback" && priorityCheck && (
          <>
            <h3 style={{ fontFamily: FS, fontSize: 20, margin: "0 0 4px" }}>Hold Up</h3>
            <p style={{ fontSize: 12, color: C.mut, margin: "0 0 16px" }}>You've got more important stuff to do first.</p>

            <div style={{ padding: "10px 14px", background: "#F8F8F6", borderRadius: 10, fontSize: 14, marginBottom: 12, fontStyle: "italic", color: C.sub }}>
              "{text}"
            </div>

            {dueDate && (
              <div style={{ padding: "8px 14px", borderRadius: 10, marginBottom: 12, fontSize: 13, color: C.amb, background: C.ambBg, border: `1px solid ${C.amb}30` }}>
                You're giving this a due date of {new Date(dueDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}, but you've got {priorityCheck.count} more important thing{priorityCheck.count !== 1 ? "s" : ""} to do first.
              </div>
            )}

            {/* Amber pushback panel */}
            <div style={{ padding: 16, background: C.ambBg, borderRadius: 10, marginBottom: 16, border: `2px solid ${C.amb}` }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.amb, marginBottom: 10 }}>
                ⚠️ {priorityCheck.count} Higher-Priority Item{priorityCheck.count !== 1 ? "s" : ""}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {priorityCheck.items.map((item, idx) => (
                  <div
                    key={item.id}
                    style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 12px", background: C.card, borderRadius: 8, borderLeft: `3px solid ${C.amb}` }}
                  >
                    <div style={{ width: 20, height: 20, borderRadius: 6, background: C.amb, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>
                      {idx + 1}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: item.source === "linear" ? "#7B1FA2" : C.amb, textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>
                        {item.source === "linear" ? "Linear" : "Task Queue"}
                      </div>
                      <div style={{ fontSize: 13, color: C.tx }}>{item.text}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: C.amb, marginTop: 12, fontWeight: 600 }}>
                Are you sure you want to add this right now?
              </div>
            </div>

            {error && (
              <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: C.redBg, color: C.red, fontSize: 12 }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleClose} style={{ ...btn2, flex: 1, color: C.amb, borderColor: C.amb }}>
                Cancel — Handle Those First
              </button>
              <button
                onClick={() => save(`Priority override: ${priorityCheck.count} higher-priority items acknowledged`)}
                style={{ ...btn1, flex: 1, background: C.amb }}
              >
                Save Anyway
              </button>
            </div>
          </>
        )}

        {/* ── STEP 5: Saving ── */}
        {step === "saving" && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
            <div style={{ fontFamily: FS, fontSize: 18, marginBottom: 8 }}>Saving your task...</div>
            <div style={{ fontSize: 13, color: C.mut }}>Adding to your queue</div>
          </div>
        )}

      </div>
    </div>
  );
}
