import { useState, useRef, useEffect, useCallback } from "react";
import { FontLink } from "./FontLink";
import { C, F, FS, TODAY_STR } from "./constants";
import { post } from "@/lib/api";
import type { Idea, SlackItem, LinearItem } from "./types";

// ─── High-urgency Slack banner ────────────────────────────────────────────────
function HighUrgencyBanner({ items, onDismiss }: { items: SlackItem[]; onDismiss: () => void }) {
  const high = items.filter(i => i.level === "high");

  useEffect(() => {
    if (high.length === 0) return;
    const timer = setTimeout(onDismiss, 15000);
    return () => clearTimeout(timer);
  }, [high.length, onDismiss]);

  if (high.length === 0) return null;
  return (
    <div style={{
      background: C.red, color: "#fff", padding: "10px 20px",
      display: "flex", justifyContent: "space-between", alignItems: "center",
      boxShadow: "0 2px 8px rgba(0,0,0,0.15)", fontFamily: F, zIndex: 48,
    }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>🔴 {high.length} High-Urgency Slack Item{high.length > 1 ? "s" : ""}</div>
        {high[0] && <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>{high[0].message?.substring(0, 100) || "Needs immediate attention"}</div>}
      </div>
      <button onClick={onDismiss} style={{ padding: "5px 12px", background: "rgba(255,255,255,0.2)", color: "#fff", border: "none", borderRadius: 7, fontSize: 12, cursor: "pointer", fontFamily: F }}>Dismiss</button>
    </div>
  );
}

interface Props {
  clock: string;
  ideas: Idea[];
  unresolved: number;
  snoozedCount?: number;
  calSide: boolean;
  eod: boolean;
  customTips: Record<string, string>;
  lastRefresh?: string;
  refreshing?: boolean;
  slackItems?: SlackItem[];
  linearItems?: LinearItem[];
  meetingWarning?: { title: string; time: string; location?: string; attendeeBrief?: string } | null;
  onSetView: (v: string) => void;
  onToggleCal: () => void;
  onShowIdea: () => void;
  onShowChat: () => void;
  onShowCheckin: () => void;
  onEod: () => void;
  onTipSaved: (key: string, text: string) => void;
  onRefresh?: (sources: string[]) => void;
  onDismissWarning?: () => void;
  onPrint?: () => void;
  /** D2 — Tony clicks ✓ to acknowledge / dismiss a Slack mention. */
  onSlackAck?: (item: SlackItem) => void;
}

const ALL_SOURCES = ["emails", "calendar", "slack", "linear", "ai"];

const SLACK_SEEN_KEY = "tcc:slack-seen-v1";

function slackItemKey(item: SlackItem): string {
  return item.url || `${item.from || ""}|${item.channel || ""}|${(item.message || "").slice(0, 120)}`;
}

function loadSeenSlack(): Set<string> {
  try {
    const raw = localStorage.getItem(SLACK_SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch { return new Set(); }
}

function saveSeenSlack(set: Set<string>) {
  try {
    const arr = Array.from(set).slice(-200);
    localStorage.setItem(SLACK_SEEN_KEY, JSON.stringify(arr));
  } catch { /* ignore */ }
}

const levelColor = (level?: string) =>
  level === "high" ? C.red : level === "mid" ? C.amb : C.grn;

const topLevel = (items: { level: string }[]) => {
  if (!items.length) return null;
  if (items.some(i => i.level === "high")) return "high";
  if (items.some(i => i.level === "mid")) return "mid";
  return "low";
};

export function Header({ clock, ideas, unresolved, snoozedCount = 0, calSide, eod, customTips: _customTips, lastRefresh, refreshing, slackItems = [], linearItems = [], meetingWarning, onSetView, onToggleCal, onShowIdea, onShowChat, onShowCheckin, onEod, onTipSaved: _onTipSaved, onRefresh, onDismissWarning, onPrint, onSlackAck }: Props) {
  const [open, setOpen] = useState(false);
  const [dismissedHighUrgency, setDismissedHighUrgency] = useState(false);
  const [showSlackPopover, setShowSlackPopover] = useState(false);
  const [seenSlack, setSeenSlack] = useState<Set<string>>(() => loadSeenSlack());

  const unseenSlackCount = slackItems.reduce((n, item) => n + (seenSlack.has(slackItemKey(item)) ? 0 : 1), 0);

  const markSlackSeen = useCallback(() => {
    if (slackItems.length === 0) return;
    setSeenSlack(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const it of slackItems) {
        const k = slackItemKey(it);
        if (!next.has(k)) { next.add(k); changed = true; }
      }
      if (changed) saveSeenSlack(next);
      return changed ? next : prev;
    });
  }, [slackItems]);

  const toggleSlackPopover = useCallback(() => {
    setShowSlackPopover(prev => {
      const next = !prev;
      if (next) markSlackSeen();
      return next;
    });
  }, [markSlackSeen]);
  const [attendeeBriefExpanded, setAttendeeBriefExpanded] = useState(false);
  const [showEodModal, setShowEodModal] = useState(false);
  const [eodText, setEodText] = useState("");
  const [eodTo, setEodTo] = useState(import.meta.env.VITE_ACCOUNTABILITY_EMAIL || "ethan@flipiq.com");
  // Default EOD subject — canonical "EOD Report — YYYY-MM-DD" in Pacific.
  // Editable in the modal so user can override before sending (Bug 14).
  const [eodSubject, setEodSubject] = useState(() => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    return `EOD Report — ${today}`;
  });
  const [eodSubjectEditing, setEodSubjectEditing] = useState(false);
  const [eodLoading, setEodLoading] = useState(false);
  const [eodSending, setEodSending] = useState(false);
  const [eodResult, setEodResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const openEodModal = useCallback(async () => {
    setOpen(false);
    setShowEodModal(true);
    setEodResult(null);
    if (eodText) return; // already loaded
    setEodLoading(true);
    try {
      const r = await post<{ ok: boolean; reportText: string }>("/eod-report/preview", {});
      if (r.ok) setEodText(r.reportText);
    } catch {
      setEodText("Could not generate preview. Edit this field with your EOD summary.");
    } finally {
      setEodLoading(false);
    }
  }, [eodText]);

  const sendEod = useCallback(async () => {
    if (eodSending || !eodTo.trim()) return;
    setEodSending(true);
    setEodResult(null);
    try {
      const r = await post<{ ok: boolean }>("/eod-report", {
        to: eodTo.trim(),
        body: eodText,
        subject: eodSubject.trim(),
      });
      if (r.ok) {
        setEodResult({ ok: true, msg: `Sent to ${eodTo.trim()}` });
        onEod();
      } else {
        setEodResult({ ok: false, msg: "Send failed — try again" });
      }
    } catch {
      setEodResult({ ok: false, msg: "Error sending — check connection" });
    } finally {
      setEodSending(false);
    }
  }, [eodSending, eodTo, eodText, eodSubject, onEod]);
  const menuRef = useRef<HTMLDivElement>(null);
  const slackPopoverRef = useRef<HTMLDivElement>(null);
  const handleDismissSlackPopover = useCallback(() => setShowSlackPopover(false), []);

  useEffect(() => {
    if (!showSlackPopover) return;
    const handler = (e: MouseEvent) => {
      if (slackPopoverRef.current && !slackPopoverRef.current.contains(e.target as Node)) {
        setShowSlackPopover(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSlackPopover]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const slackLevel = topLevel(slackItems);
  const hasNotif = unresolved > 0 || ideas.length > 0 || !!slackLevel;
  const sep = <div style={{ height: 1, background: C.brd, margin: "6px 0" }} />;

  const menuItem = (
    icon: React.ReactNode,
    label: string,
    badge: string | number | null,
    onClick: () => void,
    accent?: string,
  ) => (
    <button
      onClick={() => { onClick(); setOpen(false); }}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "8px 12px", background: "none", border: "none",
        textAlign: "left", cursor: "pointer", fontFamily: F, borderRadius: 6,
        transition: "background 0.1s",
      }}
      onMouseEnter={e => (e.currentTarget.style.background = C.bg)}
      onMouseLeave={e => (e.currentTarget.style.background = "none")}
    >
      <span style={{ width: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: C.mut }}>{icon}</span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: accent || C.tx }}>{label}</span>
      {badge !== null && badge !== undefined && Number(badge) > 0 && (
        <span style={{ fontSize: 10, fontWeight: 700, background: accent ? `${accent}22` : "#FFF7ED", color: accent || "#F97316", borderRadius: 999, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>{badge}</span>
      )}
    </button>
  );

  return (
    <>
      <FontLink />
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.brd}`,
        padding: "12px 20px", display: "flex", alignItems: "center",
        justifyContent: "space-between", position: "sticky", top: 0, zIndex: 50,
        boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
      }}>

        {/* ── Left: Logo + Title + Date ── */}
        <div style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }} onClick={() => onSetView("dashboard")}>
          <img src="/flipiq-logo.png" alt="FlipIQ" style={{ height: 40, width: "auto", flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: FS, fontSize: 18, fontWeight: 700, color: C.tx, lineHeight: 1.1 }}>
              COO Dashboard
            </div>
            <div style={{ fontSize: 12, color: C.mut, marginTop: 2, fontFamily: F }}>
              {TODAY_STR} · {clock} PT
              {refreshing && (
                <span style={{ marginLeft: 8, color: C.blu, fontWeight: 600 }}>⟳ Refreshing…</span>
              )}
            </div>
          </div>
        </div>

        {/* ── Center: Quote ── */}
        <p style={{
          fontFamily: F, fontSize: 20, color: C.tx, fontStyle: "italic",
          margin: 0, position: "absolute", left: "50%", transform: "translateX(-50%)",
          whiteSpace: "nowrap", pointerEvents: "none", fontWeight: 700,
          WebkitFontSmoothing: "antialiased", MozOsxFontSmoothing: "grayscale",
          letterSpacing: "-0.3px",
        }}>
          "Follow the plan I gave you!" — God
        </p>

        {/* ── Right: Slack Bell + Hamburger ── */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>

        {/* Standalone Slack notification bell */}
        {slackItems.length > 0 && (
          <div ref={slackPopoverRef} style={{ position: "relative" }}>
            <button
              onClick={toggleSlackPopover}
              title={`${slackItems.length} Slack mention${slackItems.length > 1 ? "s" : ""}${unseenSlackCount > 0 ? ` · ${unseenSlackCount} new` : ""}`}
              style={{
                width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center",
                background: showSlackPopover ? "#FFF7ED" : "none",
                border: `1.5px solid ${showSlackPopover ? "#F97316" : C.brd}`,
                borderRadius: 10, cursor: "pointer", position: "relative", flexShrink: 0,
              }}
            >
              <span style={{ fontSize: 15 }}>💬</span>
              {unseenSlackCount > 0 && (
                <span style={{
                  position: "absolute", top: -5, right: -5,
                  minWidth: 17, height: 17, borderRadius: 9,
                  background: slackLevel === "high" ? C.red : C.amb,
                  border: "2px solid #fff", display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 9, fontWeight: 800, color: "#fff", padding: "0 3px", lineHeight: 1,
                }}>
                  {unseenSlackCount}
                </span>
              )}
            </button>
            {showSlackPopover && (
              <div style={{
                position: "absolute", top: "calc(100% + 8px)", right: 0,
                background: C.card, border: `1px solid ${C.brd}`,
                borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.13)",
                width: 310, zIndex: 300, fontFamily: F, padding: "0 0 6px",
                animation: "fadeIn 0.12s ease-out",
              }}>
                <div style={{ padding: "10px 14px 8px", fontSize: 10, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 0.8, borderBottom: `1px solid ${C.brd}` }}>
                  Slack Mentions · {slackItems.length}
                </div>
                {slackItems.map((item, i) => {
                  const slackDeepLink = item.url
                    ? item.url
                    : item.channel
                      ? `slack://channel?team=&id=${item.channel}`
                      : "slack://open";
                  // D2: Ack only meaningful when we have the ts (channel id +
                  // ts together form the unique key the BE persists).
                  const canAck = !!(item.ts && item.channelId && onSlackAck);
                  return (
                    <div key={i} style={{ padding: "9px 14px", borderBottom: i < slackItems.length - 1 ? `1px solid ${C.brd}` : "none" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: item.level === "high" ? C.red : item.level === "mid" ? C.amb : C.mut, borderRadius: 3, padding: "1px 5px", textTransform: "uppercase" }}>
                          {item.level || "low"}
                        </span>
                        {item.channel && <span style={{ fontSize: 11, color: C.mut }}>{item.channel}</span>}
                        <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
                          {canAck && (
                            <button
                              onClick={() => onSlackAck!(item)}
                              title="Mark as handled — removes from this dashboard"
                              style={{
                                background: "none", border: `1px solid ${C.grn}55`,
                                color: C.grn, fontSize: 10, fontWeight: 700,
                                padding: "2px 8px", borderRadius: 5, cursor: "pointer", fontFamily: F,
                              }}
                            >
                              ✓ Ack
                            </button>
                          )}
                          <a href={slackDeepLink} target={item.url && item.url.startsWith("http") ? "_blank" : "_self"} rel="noopener noreferrer" style={{ fontSize: 10, color: C.blu, textDecoration: "none", fontWeight: 600, whiteSpace: "nowrap" }}>
                            Open ↗
                          </a>
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: C.tx, lineHeight: 1.45 }}>
                        {item.from && <span style={{ fontWeight: 700 }}>{item.from}: </span>}
                        {(item.message || "").substring(0, 140)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Hamburger */}
        <div ref={menuRef} style={{ position: "relative" }}>
          <button
            onClick={() => setOpen(p => !p)}
            style={{
              display: "flex", flexDirection: "column", justifyContent: "center",
              alignItems: "center", gap: 4, width: 40, height: 40,
              background: open ? "#FFF7ED" : "none",
              border: `1.5px solid ${open ? "#F97316" : C.brd}`,
              borderRadius: 10, cursor: "pointer", padding: 0,
              position: "relative",
            }}
          >
            <span style={{ display: "block", width: 18, height: 1.5, background: open ? "#F97316" : C.sub, borderRadius: 2, transition: "all 0.2s" }} />
            <span style={{ display: "block", width: 14, height: 1.5, background: open ? "#F97316" : C.sub, borderRadius: 2, transition: "all 0.2s" }} />
            <span style={{ display: "block", width: 18, height: 1.5, background: open ? "#F97316" : C.sub, borderRadius: 2, transition: "all 0.2s" }} />
            {!open && slackItems.length > 0 && (
              <span style={{
                position: "absolute", top: -6, left: -6,
                minWidth: 16, height: 16, borderRadius: 8,
                background: slackLevel === "high" ? C.red : C.amb,
                border: "2px solid #fff", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, fontWeight: 800, color: "#fff", padding: "0 3px",
                lineHeight: 1,
              }}>
                {slackItems.length}
              </span>
            )}
            {!open && unresolved > 0 && slackItems.length === 0 && (
              <span style={{
                position: "absolute", top: -3, right: -3,
                width: 9, height: 9, borderRadius: "50%",
                background: C.red, border: "2px solid #fff",
              }} />
            )}
          </button>

          {open && (
            <>
            <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 9998 }} />
            <div style={{
              position: "absolute", top: "100%", right: 0, marginTop: 8,
              background: "#fff", border: `1px solid #e0e0e0`,
              borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)",
              width: 260, zIndex: 9999, fontFamily: F,
              padding: "8px 6px", maxHeight: "calc(100vh - 80px)", overflowY: "auto",
            }}>

              {/* Refresh status row */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 14px 10px", borderBottom: `1px solid ${C.brd}`, marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: C.mut }}>
                  {refreshing
                    ? <span style={{ color: "#F97316", fontWeight: 600 }}>⟳ Refreshing…</span>
                    : lastRefresh ? `Updated ${lastRefresh}` : "Not yet refreshed"}
                </span>
                <button
                  onClick={() => { if (!refreshing && onRefresh) { setOpen(false); onRefresh(ALL_SOURCES); } }}
                  disabled={refreshing}
                  title="Refresh all"
                  style={{
                    background: "none", border: `1px solid ${C.brd}`, borderRadius: 6,
                    padding: "3px 10px", fontSize: 13, color: refreshing ? C.mut : C.tx,
                    cursor: refreshing ? "default" : "pointer", fontFamily: F,
                    opacity: refreshing ? 0.5 : 1,
                  }}
                >↻</button>
              </div>

              {/* Navigate */}
              <div style={{ padding: "4px 10px 6px", fontSize: 10, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 0.8 }}>Navigate</div>
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>, "Dashboard", null, () => onSetView("dashboard"))}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.18 1.2 2 2 0 012.18 0h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L6.91 7.09a16 16 0 006 6l1.45-1.45a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 13.92z"/></svg>, "Sales Mode", null, () => onSetView("sales"))}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>, "Calendar", null, () => onSetView("schedule"))}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>, `Emails${snoozedCount > 0 ? ` (${snoozedCount} snoozed)` : ""}`, unresolved || null, () => onSetView("emails"), unresolved > 0 ? C.red : undefined)}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>, "AI Chat", null, () => onShowChat())}

              {sep}

              {/* Business */}
              <div style={{ padding: "4px 10px 6px", fontSize: 10, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 0.8 }}>Business</div>
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>, "411 Plan", null, () => onSetView("business:goals"))}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>, "Team Roster", null, () => onSetView("business:team"))}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>, "Master Task List", null, () => onSetView("business:tasks"))}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>, "Business Plan", null, () => onSetView("business:plan"))}

              {sep}

              {/* Tools */}
              <div style={{ padding: "4px 10px 6px", fontSize: 10, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 0.8 }}>Tools</div>
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>, "Morning Check-in", null, () => onShowCheckin())}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>, "Ideas", null, () => onShowIdea())}
              {onPrint && menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>, "Print Daily Sheet", null, () => onPrint())}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>, "AI Token Usage", null, () => onSetView("ai-usage"))}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>, "Agent Training", null, () => onSetView("agents-settings"))}
              {menuItem(<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M1 9h3"/><path d="M1 15h3"/><path d="M20 9h3"/><path d="M20 15h3"/></svg>, "Model Settings", null, () => onSetView("model-settings"))}
              {sep}

              {/* EOD Report — always available, shows sent status if already sent */}
              <div
                onClick={openEodModal}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 14px", fontFamily: F, cursor: "pointer",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = C.bg)}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ width: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: C.mut }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                </span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: eod ? C.grn : C.tx }}>
                  {eod ? "EOD Sent ✓ — Resend" : "Send EOD Report"}
                </span>
              </div>
            </div>
            </>
          )}
        </div>
        </div>
      </div>

      {/* High-urgency Slack banner */}
      {!dismissedHighUrgency && slackItems.some(i => i.level === "high") && (
        <HighUrgencyBanner items={slackItems} onDismiss={() => setDismissedHighUrgency(true)} />
      )}

      {/* Meeting warning banner */}
      {meetingWarning && (
        <div style={{
          background: "#1565C0", color: "#fff", padding: "10px 20px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)", fontFamily: F, zIndex: 49,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>⏰ Meeting in 5 min: {meetingWarning.title} at {meetingWarning.time}</div>
              {meetingWarning.location && <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>📍 {meetingWarning.location}</div>}
              {meetingWarning.attendeeBrief && (
                <button
                  onClick={() => setAttendeeBriefExpanded(p => !p)}
                  style={{ marginTop: 4, background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "pointer", fontFamily: F }}
                >
                  {attendeeBriefExpanded ? "▴ Hide Brief" : "▾ View Full Brief"}
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0, marginLeft: 12 }}>
              {meetingWarning.location?.startsWith("http") && (
                <a href={meetingWarning.location} target="_blank" rel="noreferrer" style={{ padding: "5px 12px", background: "#fff", color: "#1565C0", borderRadius: 7, fontWeight: 700, fontSize: 12, textDecoration: "none" }}>Join</a>
              )}
              <button onClick={onDismissWarning} style={{ padding: "5px 12px", background: "rgba(255,255,255,0.2)", color: "#fff", border: "none", borderRadius: 7, fontSize: 12, cursor: "pointer", fontFamily: F }}>Dismiss</button>
            </div>
          </div>
          {meetingWarning.attendeeBrief && attendeeBriefExpanded && (
            <div style={{
              marginTop: 10, padding: "10px 14px", background: "rgba(255,255,255,0.12)",
              borderRadius: 8, fontSize: 12, lineHeight: 1.6, fontStyle: "italic",
              whiteSpace: "pre-wrap",
            }}>
              {meetingWarning.attendeeBrief}
            </div>
          )}
        </div>
      )}

      {/* ── EOD Report Modal ── */}
      {showEodModal && (
        <div
          onClick={() => setShowEodModal(false)}
          style={{ position: "fixed", inset: 0, background: "#00000066", zIndex: 9100, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: "#fff", borderRadius: 12, padding: "24px 28px", maxWidth: 600, width: "94%", maxHeight: "85vh", display: "flex", flexDirection: "column", gap: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", fontFamily: F }}
          >
            <div style={{ fontFamily: FS, fontSize: 18, fontWeight: 800, color: "#111" }}>📊 EOD Report</div>

            {/* To field */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 5 }}>To</div>
              <input
                value={eodTo}
                onChange={e => setEodTo(e.target.value)}
                placeholder={import.meta.env.VITE_ACCOUNTABILITY_EMAIL || "ethan@flipiq.com"}
                style={{ width: "100%", padding: "9px 12px", fontSize: 13, border: "1px solid #DDD", borderRadius: 8, fontFamily: F, boxSizing: "border-box" }}
              />
            </div>

            {/* Subject field — read-only by default, click to edit (Bug 14) */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 5 }}>Subject</div>
              {eodSubjectEditing ? (
                <input
                  autoFocus
                  value={eodSubject}
                  onChange={e => setEodSubject(e.target.value)}
                  onBlur={() => setEodSubjectEditing(false)}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") setEodSubjectEditing(false); }}
                  style={{ width: "100%", padding: "9px 12px", fontSize: 13, border: "1px solid #2563EB", borderRadius: 8, fontFamily: F, boxSizing: "border-box" }}
                />
              ) : (
                <div
                  onClick={() => setEodSubjectEditing(true)}
                  title="Click to edit subject"
                  style={{ width: "100%", padding: "9px 12px", fontSize: 13, border: "1px solid #DDD", borderRadius: 8, fontFamily: F, boxSizing: "border-box", cursor: "text", color: "#374151", background: "#FAFAFA" }}
                >
                  {eodSubject || <span style={{ color: "#999" }}>Click to set subject</span>}
                </div>
              )}
            </div>

            {/* Report body */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 5 }}>Message</div>
              {eodLoading ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#FAFAF8", borderRadius: 8, border: "1px solid #EEE", color: "#999", fontSize: 13, minHeight: 200 }}>
                  Generating EOD report…
                </div>
              ) : (
                <textarea
                  value={eodText}
                  onChange={e => setEodText(e.target.value)}
                  style={{ flex: 1, minHeight: 260, padding: "12px 14px", fontSize: 13, lineHeight: 1.65, border: "1px solid #DDD", borderRadius: 8, fontFamily: F, resize: "vertical", boxSizing: "border-box", width: "100%" }}
                />
              )}
            </div>

            {/* Result banner */}
            {eodResult && (
              <div style={{ padding: "8px 12px", borderRadius: 8, background: eodResult.ok ? "#F0FDF4" : "#FFF5F5", color: eodResult.ok ? "#15803D" : "#B91C1C", fontSize: 13, fontWeight: 600 }}>
                {eodResult.ok ? "✓ " : "⚠ "}{eodResult.msg}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => { setEodText(""); setEodResult(null); openEodModal(); }}
                disabled={eodLoading}
                style={{ fontSize: 12, padding: "8px 14px", background: "none", border: "1px solid #DDD", borderRadius: 8, cursor: "pointer", fontFamily: F, color: "#666" }}
              >
                ↻ Regenerate
              </button>
              <button
                onClick={() => setShowEodModal(false)}
                style={{ fontSize: 12, padding: "8px 14px", background: "none", border: "1px solid #DDD", borderRadius: 8, cursor: "pointer", fontFamily: F, color: "#666" }}
              >
                Cancel
              </button>
              <button
                onClick={sendEod}
                disabled={eodSending || eodLoading || !eodTo.trim()}
                style={{ fontSize: 13, fontWeight: 700, padding: "8px 22px", background: eodSending ? "#888" : "#111", color: "#fff", border: "none", borderRadius: 8, cursor: eodSending ? "default" : "pointer", fontFamily: F }}
              >
                {eodSending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes fadeIn { from { opacity:0; transform:translateY(-4px) } to { opacity:1; transform:translateY(0) } }`}</style>
    </>
  );
}
