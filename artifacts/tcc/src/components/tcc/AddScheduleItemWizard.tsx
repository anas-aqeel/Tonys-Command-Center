import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { C, F, FS, inp, lbl, btn1, btn2 } from "./constants";
import { post, get } from "../../lib/api";
import { showToast } from "./Toast";
import { showTrainNowToast } from "@/lib/trainNowToast";

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

const CATEGORIES = [
  { name: "TECH",           color: "#0B8043" },
  { name: "OPERATIONS",     color: "#E67C73" },
  { name: "DONE",           color: "#616161" },
  { name: "FINANCE",        color: "#7986CB" },
  { name: "IMPORTANT",      color: "#D50000" },
  { name: "PROJECTS",       color: "#F6BF26" },
  { name: "PERSONAL",       color: "#8E24AA" },
  { name: "MEETING",        color: "#F4511E" },
  { name: "NEEDS PLANNING", color: "#3F51B5" },
  { name: "SALES Tech",     color: "#33B679" },
];

interface Contact { name: string; email: string; }

interface EmailThread {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
}

interface GuiltTrip {
  msg: string;
  callsMade: number;
  quotaTarget: number;
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultStart(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}

function defaultEnd(start: string): string {
  const [h, m] = start.split(":").map(Number);
  const totalMin = Math.min(h * 60 + m + 60, 23 * 60 + 59); // clamp at 23:59
  return `${String(Math.floor(totalMin / 60)).padStart(2, "0")}:${String(totalMin % 60).padStart(2, "0")}`;
}

function timeToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function AddScheduleItemWizard({ onClose, onSaved }: Props) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [allDay, setAllDay] = useState(false);
  const [startTime, setStartTime] = useState(defaultStart());
  const [endTime, setEndTime] = useState(() => defaultEnd(defaultStart()));
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [notification, setNotification] = useState(10);
  const [guestInput, setGuestInput] = useState("");
  const [guests, setGuests] = useState<Contact[]>([]);
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [guiltTrip, setGuiltTrip] = useState<GuiltTrip | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("Mid");
  const [guestEmailHistory, setGuestEmailHistory] = useState<Record<string, EmailThread[]>>({});
  const [emailHistoryLoading, setEmailHistoryLoading] = useState<Set<string>>(new Set());
  const guestRef = useRef<HTMLDivElement>(null);
  const acTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close suggestions when clicking outside
  useEffect(() => {
    function onClickOut(e: MouseEvent) {
      if (guestRef.current && !guestRef.current.contains(e.target as Node))
        setShowSuggestions(false);
    }
    document.addEventListener("mousedown", onClickOut);
    return () => document.removeEventListener("mousedown", onClickOut);
  }, []);

  const handleGuestInput = useCallback((val: string) => {
    // Handle paste of multiple comma-separated emails
    if (val.includes(",") && val.includes("@")) {
      const emails = val.split(",").map(e => e.trim()).filter(e => e.includes("@"));
      for (const email of emails) {
        addGuest({ name: email.split("@")[0], email });
      }
      setGuestInput("");
      return;
    }
    setGuestInput(val);
    if (acTimer.current) clearTimeout(acTimer.current);
    if (val.length < 3) { setSuggestions([]); setShowSuggestions(false); return; }
    acTimer.current = setTimeout(async () => {
      try {
        const r = await get<Contact[]>(`/contacts/autocomplete?q=${encodeURIComponent(val)}`);
        setSuggestions(r);
        setShowSuggestions(r.length > 0);
      } catch { setSuggestions([]); setShowSuggestions(false); }
    }, 280);
  }, []);

  const addGuest = (c: Contact) => {
    if (!guests.find(g => g.email === c.email)) {
      setGuests(prev => [...prev, c]);
      // Auto-fetch email history for this guest
      if (!guestEmailHistory[c.email]) {
        setEmailHistoryLoading(prev => new Set([...prev, c.email]));
        get<EmailThread[]>(`/contacts/email-history?email=${encodeURIComponent(c.email)}`)
          .then(threads => setGuestEmailHistory(prev => ({ ...prev, [c.email]: threads })))
          .catch(() => setGuestEmailHistory(prev => ({ ...prev, [c.email]: [] })))
          .finally(() => setEmailHistoryLoading(prev => { const s = new Set(prev); s.delete(c.email); return s; }));
      }
    }
    setGuestInput("");
    setSuggestions([]);
    setShowSuggestions(false);
  };

  const removeGuest = (email: string) => {
    setGuests(prev => prev.filter(g => g.email !== email));
    setGuestEmailHistory(prev => { const n = { ...prev }; delete n[email]; return n; });
  };

  const handleGuestKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === "," || e.key === " ") && guestInput.trim()) {
      e.preventDefault();
      const raw = guestInput.trim().replace(/,$/,"");
      if (!raw) return;
      // Extract email from "Name <email>" format or plain email
      const emailMatch = raw.match(/<([^>]+@[^>]+)>/);
      const email = emailMatch ? emailMatch[1] : raw;
      if (!email.includes("@")) return; // must be an email
      const name = emailMatch ? raw.replace(/<[^>]+>/, "").trim() : email.split("@")[0];
      addGuest({ name, email });
    }
  };

  const doSave = async (forceOverride = false, reason = "") => {
    setError("");
    // Client-side validation: timed events need start < end on the same day.
    // Without this, Google Calendar rejects the request and the user sees a
    // generic 500 with no actionable message.
    if (!allDay) {
      if (timeToMin(endTime) <= timeToMin(startTime)) {
        setError("End time must be after start time.");
        return;
      }
    }
    setSaving(true);
    try {
      const result = await post<{ ok: boolean; guiltTrip?: boolean; guiltTripMsg?: string; callsMade?: number; quotaTarget?: number; htmlLink?: string; eventId?: string; feedback_id?: string }>("/schedule/add", {
        title,
        date,
        allDay,
        startTime: allDay ? undefined : startTime,
        endTime: allDay ? undefined : endTime,
        location: location || undefined,
        description: description || undefined,
        notification,
        guests: guests.map(g => g.email),
        forceOverride,
        overrideReason: reason || undefined,
        category: category || undefined,
        priority: priority || undefined,
      });

      if (!result.ok && result.guiltTrip) {
        setGuiltTrip({
          msg: result.guiltTripMsg || "This meeting is during call hours.",
          callsMade: result.callsMade ?? 0,
          quotaTarget: result.quotaTarget ?? 10,
        });
        return;
      }

      if (!result.ok && (result as any).scopeBlock) {
        setGuiltTrip({
          msg: (result as any).scopeMsg || "This doesn't look like a Sales or ops meeting. Force override?",
          callsMade: (result as any).callsMade ?? 0,
          quotaTarget: (result as any).quotaTarget ?? 10,
        });
        return;
      }

      if (!result.ok) {
        setError((result as any).error || "Failed to create event");
        return;
      }

      const whenLabel = allDay
        ? new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
        : `${new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${startTime}`;

      // If Tony forced past the guilt-trip / scope check, that's exactly the
      // signal Coach wants to learn from — backend wrote a feedback row.
      // Surface the Train-now toast pointing at it. Otherwise, normal toast.
      if (forceOverride) {
        showTrainNowToast({
          agent: "schedule",
          feedbackId: result.feedback_id ?? null,
          sourceId: result.eventId ?? null,
          title: "Event created (override logged)",
          description: `${title} — ${whenLabel} · Train the schedule agent on this override?`,
        });
      } else {
        showToast({ title: "Event created", description: `${title} — ${whenLabel}` });
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.45)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: 20,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: C.card, borderRadius: 18, width: "100%", maxWidth: 520,
        maxHeight: "90vh", overflowY: "auto",
        boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "20px 24px 16px",
          borderBottom: `1px solid ${C.brd}`,
        }}>
          <span style={{ fontSize: 18, fontWeight: 800, fontFamily: FS }}>New Event</span>
          <button onClick={onClose} style={{
            background: "none", border: "none", fontSize: 20,
            color: C.sub, cursor: "pointer", lineHeight: 1,
          }}>✕</button>
        </div>

        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Title */}
          <input
            autoFocus
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Add title"
            style={{
              ...inp,
              fontSize: 20, fontWeight: 700, border: "none",
              borderBottom: `2px solid ${C.brd}`, borderRadius: 0,
              padding: "6px 0",
            }}
          />

          {/* Date + Time */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 16 }}>🕐</span>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                style={{ ...inp, flex: 1, fontSize: 14 }}
              />
            </div>

            {!allDay && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 28 }}>
                <input
                  type="time"
                  value={startTime}
                  onChange={e => {
                    const newStart = e.target.value;
                    setStartTime(newStart);
                    // Auto-bump end if it would become invalid. Keeps UX
                    // smooth: changing start to a later time slides end too.
                    if (timeToMin(newStart) >= timeToMin(endTime)) {
                      setEndTime(defaultEnd(newStart));
                    }
                  }}
                  style={{ ...inp, flex: 1, fontSize: 14 }}
                />
                <span style={{ color: C.mut, fontSize: 13 }}>to</span>
                <input
                  type="time"
                  value={endTime}
                  onChange={e => setEndTime(e.target.value)}
                  style={{ ...inp, flex: 1, fontSize: 14 }}
                />
              </div>
            )}

            <label style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 28, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={allDay}
                onChange={e => setAllDay(e.target.checked)}
                style={{ width: 16, height: 16, cursor: "pointer" }}
              />
              <span style={{ fontSize: 14, color: C.sub, fontFamily: F }}>All day</span>
            </label>
          </div>

          {/* Guests */}
          <div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, width:"420px" }}>
              <span style={{ fontSize: 16, paddingTop: 10 }}>👥</span>
              <div style={{ flex: 1 }} ref={guestRef}>
                <div style={{ position: "relative" }}>
                  <input
                    value={guestInput}
                    onChange={e => handleGuestInput(e.target.value)}
                    onKeyDown={handleGuestKeyDown}
                    onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                    placeholder="Type email and press Enter"
                    style={{ ...inp, fontSize: 14 }}
                    type="email"
                  />
                  {showSuggestions && (
                    <div style={{
                      position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10,
                      background: C.card, border: `1px solid ${C.brd}`, borderRadius: 10,
                      boxShadow: "0 4px 20px rgba(0,0,0,0.1)", maxHeight: 180, overflowY: "auto",
                    }}>
                      {suggestions.map((s, i) => (
                        <div
                          key={i}
                          onClick={() => addGuest(s)}
                          style={{
                            padding: "10px 14px", cursor: "pointer", fontSize: 13,
                            borderBottom: i < suggestions.length - 1 ? `1px solid ${C.brd}` : "none",
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = C.bg)}
                          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                        >
                          <div style={{ fontWeight: 600, color: C.tx }}>{s.name}</div>
                          <div style={{ fontSize: 11, color: C.mut }}>{s.email}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {guests.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {guests.map(g => (
                        <span key={g.email} style={{
                          display: "flex", alignItems: "center", gap: 4,
                          background: "#F0F0F0", color: C.tx,
                          borderRadius: 20, padding: "4px 10px", fontSize: 12, fontWeight: 600,
                        }}>
                          {g.name || g.email}
                          <button onClick={() => removeGuest(g.email)} style={{
                            background: "none", border: "none", cursor: "pointer",
                            color: "#999", fontSize: 14, lineHeight: 1, padding: 0,
                          }}>×</button>
                        </span>
                      ))}
                    </div>

                    {/* Email history per guest */}
                    {guests.map(g => {
                      const threads = guestEmailHistory[g.email];
                      const loading = emailHistoryLoading.has(g.email);
                      if (!loading && (!threads || threads.length === 0)) return null;
                      return (
                        <div key={g.email} style={{ marginTop: 10, borderTop: `1px solid ${C.brd}`, paddingTop: 8 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
                            {loading ? `Loading emails with ${g.name || g.email}…` : `Recent emails with ${g.name || g.email}`}
                          </div>
                          {!loading && threads?.map(t => {
                            const gmailUrl = `https://mail.google.com/mail/u/0/#all/${t.threadId}`;
                            const dateStr = t.date ? new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
                            const fromName = t.from.replace(/<.*>/, "").trim() || t.from;
                            return (
                              <a
                                key={t.threadId}
                                href={gmailUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ display: "block", textDecoration: "none", padding: "6px 0", borderBottom: `1px solid ${C.brd}` }}
                              >
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                                  <span style={{ fontSize: 12, fontWeight: t.unread ? 700 : 500, color: C.tx, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                                    {t.subject || "(no subject)"}
                                  </span>
                                  <span style={{ fontSize: 11, color: "#999", flexShrink: 0 }}>{dateStr}</span>
                                </div>
                                <div style={{ fontSize: 11, color: "#777", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {fromName} — {t.snippet}
                                </div>
                              </a>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Location */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>📍</span>
            <input
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="Add location"
              style={{ ...inp, flex: 1, fontSize: 14 }}
            />
          </div>

          {/* Category (color label) */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ fontSize: 16 }}>🏷</span>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: category ? 6 : 0 }}>
                {CATEGORIES.map(cat => (
                  <button
                    key={cat.name}
                    title={cat.name}
                    onClick={() => setCategory(prev => prev === cat.name ? "" : cat.name)}
                    style={{
                      width: 22, height: 22, borderRadius: "50%",
                      background: cat.color, border: category === cat.name ? "3px solid #000" : "2px solid transparent",
                      cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                      padding: 0, flexShrink: 0,
                    }}
                  >
                    {category === cat.name && <span style={{ fontSize: 11, color: "#fff", fontWeight: 700, lineHeight: 1 }}>✓</span>}
                  </button>
                ))}
              </div>
              {category && (
                <div style={{ fontSize: 12, color: "#555" }}>
                  {CATEGORIES.find(c => c.name === category)?.color && (
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: CATEGORIES.find(c => c.name === category)!.color, marginRight: 5 }} />
                  )}
                  {category}
                </div>
              )}
            </div>
          </div>

          {/* Priority */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>⬆</span>
            <div style={{ display: "flex", gap: 6 }}>
              {["High", "Mid", "Low"].map(p => (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  style={{
                    padding: "5px 14px", fontSize: 12, fontWeight: 600,
                    border: `1px solid ${priority === p ? C.tx : C.brd}`,
                    borderRadius: 20, cursor: "pointer",
                    background: priority === p ? C.tx : "transparent",
                    color: priority === p ? "#fff" : C.sub,
                  }}
                >{p}</button>
              ))}
            </div>
          </div>

          {/* Notification */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>🔔</span>
            <select
              value={notification}
              onChange={e => setNotification(Number(e.target.value))}
              style={{ ...inp, flex: 1, fontSize: 14 }}
            >
              <option value={0}>No notification</option>
              <option value={5}>5 minutes</option>
              <option value={10}>10 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={120}>2 hours</option>
              <option value={1440}>1 day</option>
            </select>
          </div>

          {/* Description */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ fontSize: 16, paddingTop: 10 }}>📝</span>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Add description"
              rows={3}
              style={{ ...inp, flex: 1, fontSize: 14, resize: "vertical" }}
            />
          </div>

          {error && (
            <div style={{
              background: C.redBg, color: C.red, fontSize: 13,
              padding: "10px 14px", borderRadius: 8,
            }}>
              {error}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 4 }}>
            <button onClick={onClose} style={btn2}>Cancel</button>
            <button
              onClick={() => doSave(false)}
              disabled={saving || !title.trim()}
              style={{ ...btn1, opacity: saving || !title.trim() ? 0.5 : 1 }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>

      {/* Guilt Trip Overlay */}
      {guiltTrip && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 10000,
          background: "rgba(0,0,0,0.65)", display: "flex",
          alignItems: "center", justifyContent: "center", padding: 24,
        }}>
          <div style={{
            background: C.card, borderRadius: 20, padding: 32,
            maxWidth: 420, width: "100%",
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          }}>
            <div style={{ fontSize: 36, textAlign: "center", marginBottom: 12 }}>⚠️</div>
            <div style={{ fontSize: 19, fontWeight: 800, fontFamily: FS, color: C.red, textAlign: "center", marginBottom: 12 }}>
              Hold on, Tony.
            </div>
            <div style={{
              background: C.redBg, borderRadius: 12, padding: "14px 16px",
              fontSize: 14, color: C.tx, lineHeight: 1.6, marginBottom: 16,
            }}>
              {guiltTrip.msg}
            </div>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: C.ambBg, borderRadius: 10, padding: "10px 16px", marginBottom: 16,
            }}>
              <span style={{ fontSize: 13, color: C.amb, fontWeight: 700 }}>📞 Calls today</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: C.tx }}>
                {guiltTrip.callsMade} / {guiltTrip.quotaTarget}
              </span>
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={{
                display: "block", fontSize: 12, fontWeight: 700, color: C.mut,
                marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4,
              }}>
                Why are you doing it anyway? (optional)
              </label>
              <textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                rows={2}
                placeholder="e.g. Investor flying in tomorrow only — can't reschedule"
                style={{
                  width: "100%", padding: "8px 10px", fontSize: 13,
                  border: `1px solid ${C.brd}`, borderRadius: 8, resize: "vertical",
                  fontFamily: "inherit", color: C.tx, background: C.card,
                }}
              />
              <div style={{ fontSize: 11, color: C.mut, marginTop: 4 }}>
                Helps the schedule agent learn what actually warrants overriding.
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => { setGuiltTrip(null); setOverrideReason(""); }} style={{ ...btn2, flex: 1, borderColor: C.grn, color: C.grn }}>
                I'll reschedule
              </button>
              <button onClick={() => { const r = overrideReason; setGuiltTrip(null); setOverrideReason(""); doSave(true, r); }} disabled={saving}
                style={{ ...btn1, flex: 1, background: C.red, opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Do it anyway"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
