import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { C, F, FS } from "./constants";
import { get, patch, post } from "@/lib/api";
import { ContactDrawer } from "./ContactDrawer";
import { SmsModal } from "./SmsModal";
import type { TaskItem, CalItem, EmailItem, LinearItem, SlackItem, CallEntry, Contact } from "./types";

// ── Types ──────────────────────────────────────────────────────────
interface LocalTask { id: string; text: string; dueDate?: string | null; taskType?: string | null; size?: string | null; }
// Contact type imported from ./types — kept canonical so the parent's Contact
// state (with required id + extra fields like followUpDate) plumbs through
// without TS structural-type-mismatch on the onContactUpdated callback.
type NavView = "emails" | "schedule" | "sales" | "tasks";

interface Props {
  tasks: TaskItem[];
  tDone: Record<string, boolean>;
  calendarData: CalItem[];
  emailsImportant: EmailItem[];
  linearItems: LinearItem[];
  slackItems?: SlackItem[];
  contacts: Contact[];
  calls?: CallEntry[];
  emailsLoaded?: boolean;
  briefLoaded?: boolean;
  lastEmailAiAt?: Date | null;
  onComplete: (task: TaskItem) => void;
  onNavigate: (view: NavView) => void;
  onOpenEmail?: (em: EmailItem) => void;
  onAttempt?: (contact: { id: string | number; name: string; email?: string }) => void;
  onCompose?: (contact: Contact) => void;
  // Propagate contact edits from the ContactDrawer up to the parent so the
  // Sales Calls table re-renders immediately after a status / follow-up change
  // (Tony's 2026-05-16 "Andy Polock" feedback).
  onContactUpdated?: (contact: Contact) => void;
}


// ── Time scheduling ─────────────────────────────────────────────────
function parseTimeMins(t: string): number | null {
  const m = t?.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const p = m[3].toUpperCase();
  if (p === "PM" && h !== 12) h += 12;
  if (p === "AM" && h === 12) h = 0;
  return h * 60 + min;
}
function fmtMins(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const p = h >= 12 ? "PM" : "AM";
  const dh = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${dh}:${m.toString().padStart(2, "0")} ${p}`;
}
interface WorkBlock { start: number; end: number; label: string; kind: "sales" | "email"; }

function computeWorkBlocks(meetingList: CalItem[]) {
  const WORK_START = 8 * 60, WORK_END = 18 * 60, MIN_USEFUL = 30;
  const SALES_NEED = 120, EMAIL_NEED = 30;
  const busy = meetingList.map(m => {
    const start = parseTimeMins(m.t);
    const end = m.tEnd ? parseTimeMins(m.tEnd) : (start !== null ? start + 30 : null);
    return start !== null && end !== null ? { start, end } : null;
  }).filter(Boolean).sort((a, b) => a!.start - b!.start) as { start: number; end: number }[];

  const getFreeSlots = (occupiedBusy: { start: number; end: number }[]) => {
    const free: { start: number; end: number }[] = [];
    let cursor = WORK_START;
    for (const b of occupiedBusy) {
      if (b.start > cursor + MIN_USEFUL) free.push({ start: cursor, end: b.start });
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < WORK_END - MIN_USEFUL) free.push({ start: cursor, end: WORK_END });
    return free;
  };

  const fmt = (b: { start: number; end: number }) => `${fmtMins(b.start)} – ${fmtMins(b.end)}`;

  const free0 = getFreeSlots(busy);
  const morning = free0.filter(b => b.start < 12 * 60 && (b.end - b.start) >= MIN_USEFUL);
  const afternoon = free0.filter(b => b.start >= 11 * 60 && (b.end - b.start) >= MIN_USEFUL);

  // ── Compute Sales Calls auto-blocks (2 hrs starting 8 AM, split if needed) ──
  const autoBlocks: WorkBlock[] = [];
  let salesRemaining = SALES_NEED;
  const busyForSales = [...busy];
  for (const slot of getFreeSlots(busyForSales)) {
    if (salesRemaining <= 0) break;
    if (slot.start < WORK_START) continue;
    const avail = slot.end - slot.start;
    if (avail < MIN_USEFUL) continue;
    const take = Math.min(avail, salesRemaining);
    const isFirst = salesRemaining === SALES_NEED;
    const needsSplit = salesRemaining < SALES_NEED;
    autoBlocks.push({
      start: slot.start,
      end: slot.start + take,
      label: isFirst ? (take < SALES_NEED ? "Sales Calls (pt. 1)" : "Sales Calls") : needsSplit ? "Sales Calls (pt. 2)" : "Sales Calls",
      kind: "sales",
    });
    busyForSales.push({ start: slot.start, end: slot.start + take });
    busyForSales.sort((a, b) => a.start - b.start);
    salesRemaining -= take;
  }

  // ── Compute Priority Email block (30 min after sales calls) ──
  const allOccupied = [...busy, ...autoBlocks.map(b => ({ start: b.start, end: b.end }))].sort((a, b) => a.start - b.start);
  for (const slot of getFreeSlots(allOccupied)) {
    const avail = slot.end - slot.start;
    if (avail >= EMAIL_NEED) {
      autoBlocks.push({ start: slot.start, end: slot.start + EMAIL_NEED, label: "Priority Emails", kind: "email" });
      break;
    }
  }

  return {
    salesCalls: morning[0] ? fmt(morning[0]) : free0[0] ? fmt(free0[0]) : undefined,
    tasks: morning[1] ? fmt(morning[1]) : afternoon[0] ? fmt(afternoon[0]) : undefined,
    emails: afternoon[0] ? fmt(afternoon[0]) : free0[2] ? fmt(free0[2]) : undefined,
    autoBlocks,
  };
}

// ── Design tokens ───────────────────────────────────────────────────
const BLK = "#111";
const BORDER = "1px solid #D4D4D4";
const HEAVY = "2px solid #222";
const HDR_BG = "#F0F0EE";
const DATE_STR = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

// ── Day Timeline ─────────────────────────────────────────────────────
const TL_START = 6 * 60;              // 6:00 AM in minutes from midnight
const TL_END   = 21 * 60;            // 9:00 PM
const TL_TOTAL = TL_END - TL_START;  // 900 minutes
const PPM      = 2;                   // pixels per minute → 1800px total
const TL_W     = TL_TOTAL * PPM;     // 1800px

function getCurrentMins() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === "hour")?.value || "0");
  const m = parseInt(parts.find(p => p.type === "minute")?.value || "0");
  const s = parseInt(parts.find(p => p.type === "second")?.value || "0");
  return (h === 24 ? 0 : h) * 60 + m + s / 60;
}

function DayTimeline({ meetings, autoBlocks, onNavigate }: { meetings: CalItem[]; autoBlocks: WorkBlock[]; onNavigate?: (v: NavView) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nowMins, setNowMins] = useState<number>(getCurrentMins);
  const containerWidthRef = useRef<number>(0);
  const pausedUntilRef = useRef<number>(0);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const centerOnNow = useCallback((force = false, smooth = false) => {
    if (!force && Date.now() < pausedUntilRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const w = containerWidthRef.current || el.clientWidth || el.offsetWidth;
    if (!w) return;
    const mins = getCurrentMins();
    const clamped = Math.max(TL_START, Math.min(mins, TL_END));
    const nx = (clamped - TL_START) * PPM;
    const target = Math.max(0, nx - w / 2);
    if (smooth) {
      el.scrollTo({ left: target, behavior: 'smooth' });
    } else {
      el.scrollLeft = target;
    }
  }, []);

  // ResizeObserver — cache width and fire initial center once measured
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let initialCentered = false;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        containerWidthRef.current = entry.contentRect.width;
      }
      if (!initialCentered && containerWidthRef.current > 0) {
        initialCentered = true;
        centerOnNow(true);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [centerOnNow]);

  // Tick every second — keep nowMins fresh and re-center continuously
  useEffect(() => {
    const interval = setInterval(() => {
      setNowMins(getCurrentMins());
      centerOnNow();
    }, 1_000);
    return () => clearInterval(interval);
  }, [centerOnNow]);

  // Clean up resume timer on unmount
  useEffect(() => {
    return () => {
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    };
  }, []);

  const pan = (delta: number) => {
    if (!containerRef.current) return;
    containerRef.current.scrollLeft = Math.max(0, Math.min(containerRef.current.scrollLeft + delta, TL_W));
    pausedUntilRef.current = Date.now() + 5_000;
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => {
      pausedUntilRef.current = 0;
      centerOnNow(true, true);
    }, 5_000);
  };

  const nowX  = (nowMins - TL_START) * PPM;
  const inDay = nowMins >= TL_START && nowMins <= TL_END;
  const hours = Array.from({ length: 16 }, (_, i) => i + 6); // 6 AM..9 PM

  const arrowBtn: React.CSSProperties = {
    flexShrink: 0, width: 30, alignSelf: "stretch",
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "#F8F8F8", border: "none", cursor: "pointer",
    fontSize: 18, fontWeight: 900, color: "#444",
    padding: 0,
  };

  return (
    <div style={{ borderBottom: "1px solid #EBEBEB", display: "flex", alignItems: "stretch", userSelect: "none" }}>
      <button style={{ ...arrowBtn, borderRight: "1px solid #E8E8E8" }} onClick={() => pan(-240)} title="Earlier">‹</button>
      <div
        ref={containerRef}
        style={{ flex: 1, overflowX: "hidden", overflowY: "hidden", padding: "8px 0 0" } as React.CSSProperties}
      >
        <div style={{ position: "relative", width: TL_W, height: 90, flexShrink: 0 }}>

          {/* Hour gridlines + labels */}
          {hours.map(h => {
            const x = (h * 60 - TL_START) * PPM;
            const isNoon = h === 12;
            const label  = isNoon ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`;
            return (
              <React.Fragment key={h}>
                <div style={{
                  position: "absolute", left: x, top: 0, bottom: 22,
                  width: 1, background: h === 8 ? "transparent" : "#EBEBEB",
                }} />
                <div style={{
                  position: "absolute", left: x + 3, bottom: 5,
                  fontSize: 8, fontWeight: isNoon ? 800 : 600,
                  color: isNoon ? "#555" : "#BBB",
                  letterSpacing: 0.2, whiteSpace: "nowrap",
                }}>
                  {label}
                </div>
              </React.Fragment>
            );
          })}

          {/* Meeting blocks */}
          {meetings.map((m, i) => {
            const startMin = parseTimeMins(m.t);
            const endMin   = m.tEnd ? parseTimeMins(m.tEnd) : startMin !== null ? startMin + 30 : null;
            if (startMin === null || endMin === null) return null;
            const x = Math.max(0, (startMin - TL_START) * PPM);
            const w = Math.max(6, (endMin - startMin) * PPM - 2);
            const wide = w > 100;
            const timeRange = wide
              ? `${m.t}${m.tEnd ? ` – ${m.tEnd}` : ""}`
              : m.t.replace(/ (AM|PM)$/i, "");
            return (
              <div key={i}
                onClick={() => onNavigate?.("schedule")}
                title={`${m.n}${m.t ? ` · ${m.t}` : ""}${m.loc ? ` · ${m.loc}` : ""}${m.note ? ` — ${m.note}` : ""} — Click to open Calendar`}
                style={{
                position: "absolute", left: x, top: 6,
                width: w, height: 58,
                background: "#fff", border: "1.5px solid #222",
                borderRadius: 3, padding: "4px 5px",
                overflow: "hidden", boxSizing: "border-box",
                cursor: onNavigate ? "pointer" : "default",
                transition: "border-color 0.15s, background 0.15s",
              }}
              onMouseEnter={e => { if (onNavigate) { e.currentTarget.style.borderColor = "#2563EB"; e.currentTarget.style.background = "#F0F6FF"; }}}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#222"; e.currentTarget.style.background = "#fff"; }}
              >
                <div style={{
                  fontSize: 9, fontWeight: 900, color: "#111",
                  lineHeight: 1.2, whiteSpace: "nowrap",
                  overflow: "hidden", textOverflow: "ellipsis",
                }}>
                  {m.n}
                </div>
                <div style={{ fontSize: 8, color: "#777", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {timeRange}
                </div>
                {wide && m.loc && (
                  <div style={{ fontSize: 8, color: "#AAA", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {m.loc}
                  </div>
                )}
              </div>
            );
          })}

          {/* Auto-inserted SUGGESTED work blocks (Sales Calls + Priority Emails).
              H2 (Tony's 2026-05-22 screenshot feedback): these are not real
              calendar events — they're client-side suggestions for where his
              10 calls + priority email block could fit. Visually distinguish
              with a dashed border, reduced opacity, and an explicit
              "suggested" badge so they no longer look like booked meetings.
              Hover tooltip explains they're suggestions, not bookings. */}
          {autoBlocks.map((blk, i) => {
            const x = Math.max(0, (blk.start - TL_START) * PPM);
            const w = Math.max(6, (blk.end - blk.start) * PPM - 2);
            const isSales = blk.kind === "sales";
            const borderColor = isSales ? "#C62828" : "#E65100";
            const bgColor = isSales ? "#FFF0F0" : "#FFF5EC";
            const textColor = isSales ? "#C62828" : "#E65100";
            const wide = w > 80;
            const tooltip = `Suggested time for your daily ${isSales ? "10 calls" : "priority email block"} — not on your calendar.`;
            return (
              <div
                key={`auto-${i}`}
                title={tooltip}
                style={{
                  position: "absolute", left: x, top: 6,
                  width: w, height: 58,
                  background: bgColor,
                  border: `1.5px dashed ${borderColor}`,
                  borderRadius: 3, padding: "4px 5px",
                  overflow: "hidden", boxSizing: "border-box",
                  cursor: "help",
                  opacity: 0.7,
                }}
              >
                <div style={{
                  position: "absolute", top: 2, right: 3,
                  fontSize: 7, fontWeight: 700, color: textColor,
                  background: "#fff", border: `1px solid ${borderColor}55`,
                  padding: "0 3px", borderRadius: 2,
                  textTransform: "uppercase", letterSpacing: 0.3,
                  lineHeight: 1.3,
                }}>
                  suggested
                </div>
                <div style={{
                  fontSize: 9, fontWeight: 800, fontStyle: "italic", color: textColor,
                  lineHeight: 1.2, whiteSpace: "nowrap",
                  overflow: "hidden", textOverflow: "ellipsis",
                  marginRight: wide ? 56 : 0, // leave room for the suggested badge
                }}>
                  {blk.label}
                </div>
                {wide && (
                  <div style={{ fontSize: 8, color: textColor, opacity: 0.7, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {fmtMins(blk.start)} – {fmtMins(blk.end)}
                  </div>
                )}
              </div>
            );
          })}

          {/* Now line — thin green vertical line */}
          {inDay && (
            <div style={{
              position: "absolute", left: nowX, top: 0, bottom: 0,
              width: 1, background: "#16A34A", zIndex: 1,
            }} />
          )}

        </div>
      </div>
      <button style={{ ...arrowBtn, borderLeft: "1px solid #E8E8E8" }} onClick={() => pan(240)} title="Later">›</button>
    </div>
  );
}

// ── Interactive checkbox ─────────────────────────────────────────────
function CB({ id, checked, onToggle }: { id: string; checked: boolean; onToggle: (id: string) => void }) {
  return (
    <div onClick={() => onToggle(id)} style={{
      width: 16, height: 16,
      border: checked ? "2px solid #111" : "1.5px solid #aaa",
      borderRadius: 3, background: checked ? "#111" : "#fff",
      cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, transition: "all 0.12s",
    }}>
      {checked && <span style={{ color: "#fff", fontSize: 10, lineHeight: 1, fontWeight: 900 }}>✓</span>}
    </div>
  );
}

// ── Section label with optional nav link and time badge ──────────────
function SL({ text, color = "#444", time, view, onNavigate }: {
  text: string; color?: string; time?: string;
  view?: NavView; onNavigate?: (v: NavView) => void;
}) {
  const clickable = view && onNavigate;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      marginBottom: 5, marginTop: 16,
    }}>
      <div
        onClick={clickable ? () => onNavigate!(view!) : undefined}
        style={{
          fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 1.4,
          color, cursor: clickable ? "pointer" : "default",
          borderBottom: clickable ? `1.5px solid ${color}55` : "none",
          paddingBottom: clickable ? 1 : 0,
          display: "flex", alignItems: "center", gap: 4,
        }}
      >
        {text}
        {clickable && <span style={{ fontSize: 9, opacity: 0.6 }}>↗</span>}
      </div>
      {time && (
        <div style={{
          fontSize: 9, fontWeight: 700, color: "#888",
          background: "#EFEFED", border: "1px solid #DDD", borderRadius: 4,
          padding: "1px 7px", letterSpacing: 0.3, fontFamily: "monospace",
        }}>{time}</div>
      )}
    </div>
  );
}

// ── Table helpers ────────────────────────────────────────────────────
function TH({ children, w, center }: { children: React.ReactNode; w?: number; center?: boolean }) {
  return (
    <th style={{
      fontSize: 8, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8,
      color: "#555", padding: "4px 7px", textAlign: center ? "center" : "left",
      background: HDR_BG, borderBottom: HEAVY, whiteSpace: "nowrap",
      width: w !== undefined ? w : undefined,
    }}>{children}</th>
  );
}
function TD({ children, center, bold, small, dim, strike }: {
  children?: React.ReactNode; center?: boolean; bold?: boolean;
  small?: boolean; dim?: boolean; strike?: boolean;
}) {
  return (
    <td style={{
      fontSize: small ? 9 : 11, fontWeight: bold ? 700 : 400,
      color: dim ? "#999" : BLK, padding: "5px 7px",
      textAlign: center ? "center" : "left",
      textDecoration: strike ? "line-through" : "none",
      borderBottom: "1px solid #EBEBEB", verticalAlign: "top",
    }}>{children}</td>
  );
}

// ── Management task table (Ethan / Ramy) ────────────────────────────
function MgmtTable({ items, prefix, todayStr, trackStatus, fmtDue, fmtCycle, setHoveredLin, setTooltipPos, slackItems = [] }: {
  items: LinearItem[];
  prefix: string;
  todayStr: string;
  trackStatus: (l: LinearItem) => "overdue" | "due-today" | "due-soon" | "ok" | "no-date";
  fmtDue: (d: string | null | undefined) => string;
  fmtCycle: (l: LinearItem) => { label: string; sub: string; tone: "ok" | "soon" | "over" | "none" };
  setHoveredLin: (l: LinearItem | null) => void;
  setTooltipPos: (p: { x: number; y: number }) => void;
  slackItems?: SlackItem[];
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", border: BORDER, marginBottom: 12 }}>
      <thead>
        <tr>
          <TH w={22} center>ST</TH>
          <TH w={68}>ID</TH>
          <TH>TASK</TH>
          <TH w={92} center>CYCLE</TH>
          <TH w={68} center>STATUS</TH>
          <TH w={36} center>SIZE</TH>
        </tr>
      </thead>
      <tbody>
        {items.map((l, i) => {
          const isDone = l.stateType === "completed" || l.stateType === "cancelled";
          const ts = trackStatus(l);
          const rowBg = isDone ? "#F9F9F9" : l.level === "high" ? "#FFF5F5" : "#fff";
          const trackColor = isDone ? "#999" : ts === "overdue" ? "#C62828" : ts === "due-today" ? "#E65100" : ts === "due-soon" ? "#B45309" : ts === "no-date" ? "#999" : "#2E7D32";
          const trackLabel = isDone ? "— Done" : ts === "overdue" ? "✗ Overdue" : ts === "due-today" ? "🔥 Today" : ts === "due-soon" ? "⚠ Due Soon" : ts === "no-date" ? "—" : "✓ OK";
          const sizeColor = l.size === "XL" ? "#C62828" : l.size === "L" ? "#1565C0" : l.size === "M" ? "#2E7D32" : "#888";
          const stateGlyph = isDone && l.stateType === "completed" ? "✓" : isDone ? "✕" : l.stateType === "started" ? "▷" : l.stateType === "backlog" ? "·" : "○";
          const stateColor = isDone && l.stateType === "completed" ? "#2E7D32" : isDone ? "#999" : l.stateType === "started" ? "#2563EB" : "#aaa";
          // Match on COM-411-style identifier (preferred), falling back to the id field
          // since the daily-brief response stuffs the identifier into id while /linear/live keeps it separate.
          const linId = l.identifier || (l.id && !/^[0-9a-f-]{32,}$/i.test(l.id) ? l.id : "");
          const isMentioned = !!linId && slackItems.some(s => s.message?.includes(linId));
          return (
            <tr
              key={`${prefix}-${i}`}
              className="dash-row-hover"
              style={{ background: rowBg, opacity: isDone ? 0.55 : 1, cursor: l.url ? "pointer" : "default" }}
              onClick={() => l.url && window.open(l.url, "_blank", "noopener")}
              onMouseEnter={e => { setHoveredLin(l); setTooltipPos({ x: e.clientX, y: e.clientY }); }}
              onMouseMove={e => setTooltipPos({ x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHoveredLin(null)}
            >
              <TD center>
                <span style={{ fontSize: 13, fontWeight: 800, color: stateColor, lineHeight: 1 }}>{stateGlyph}</span>
              </TD>
              <TD small bold>
                {l.url
                  ? <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: "#2563EB", textDecoration: "none" }}>{l.identifier || l.id}</a>
                  : <span style={{ color: "#2563EB" }}>{l.identifier || l.id}</span>
                }
              </TD>
              <TD strike={isDone}>
                <span style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  <span>{l.task}</span>
                  {isMentioned && (
                    <span style={{ fontSize: 9, fontWeight: 800, background: C.bluBg, color: C.blu, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap", letterSpacing: 0.3 }}>@ Mentioned</span>
                  )}
                </span>
              </TD>
              <TD small center>
                {(() => {
                  const c = fmtCycle(l);
                  if (c.tone === "none" && c.label === "—") {
                    return <span style={{ fontWeight: 700, color: "#B45309", fontSize: 9, letterSpacing: 0.3 }}>⚠ No cycle</span>;
                  }
                  const subColor = c.tone === "over" ? "#C62828" : c.tone === "soon" ? "#E65100" : c.tone === "ok" ? "#2E7D32" : "#999";
                  return (
                    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
                      <span style={{ fontWeight: 700, color: "#374151", fontSize: 10 }}>{c.label}</span>
                      {c.sub && <span style={{ fontSize: 9, fontWeight: 600, color: subColor }}>{c.sub}</span>}
                    </div>
                  );
                })()}
              </TD>
              <TD small center>
                <span style={{ fontWeight: 700, color: trackColor }}>{trackLabel}</span>
              </TD>
              <TD small center>
                <span style={{ fontWeight: 800, color: sizeColor }}>{l.size || "—"}</span>
              </TD>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── White "page" card ────────────────────────────────────────────────
function Sheet({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div style={{ marginBottom: 0 }}>
      <div style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, fontWeight: 700, textTransform: "uppercase", fontFamily: F, marginBottom: 8 }}>{label}</div>
      <div style={{
        background: "#fff", borderRadius: 4,
        boxShadow: "0 4px 24px rgba(0,0,0,0.35), 0 1px 4px rgba(0,0,0,0.15)",
        overflow: "hidden", fontFamily: F, color: BLK, fontSize: 11,
      }}>
        {children}
      </div>
    </div>
  );
}

// ── Page header ──────────────────────────────────────────────────────
function PageHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ padding: "12px 18px 10px", borderBottom: HEAVY, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
      <div>
        <div style={{ fontFamily: FS, fontSize: 16, fontWeight: 900, letterSpacing: 0.8, color: BLK }}>{title}</div>
        <div style={{ fontSize: 10, color: "#777", marginTop: 2 }}>{DATE_STR}</div>
      </div>
      <div style={{ fontSize: 9, color: "#999", fontStyle: "italic", textAlign: "right", maxWidth: 260, lineHeight: 1.4 }}>"{sub}"</div>
    </div>
  );
}

// ── Linear table filter bar ──────────────────────────────────────────
type LinFiltersShape = {
  teams: string[]; projects: string[];
  cycle: "all" | "current" | "next" | "none";
  statuses: string[]; owners: string[]; priorities: string[]; sizes: string[]; labels: string[];
  due: "all" | "overdue" | "today" | "this-week" | "no-date";
  search: string;
};

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "3px 9px", borderRadius: 999, fontSize: 10, fontWeight: 700,
        border: `1px solid ${active ? "#E65100" : "#D1D5DB"}`,
        background: active ? "#FFF3EB" : "#fff",
        color: active ? "#9A3412" : "#374151",
        cursor: "pointer", whiteSpace: "nowrap", letterSpacing: 0.2,
      }}
    >{label}</button>
  );
}

function FilterDropdown({ label, options, selected, onChange }: {
  label: string; options: string[]; selected: string[]; onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const summary = selected.length === 0 ? label : selected.length === 1 ? selected[0] : `${label} (${selected.length})`;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          padding: "3px 10px", borderRadius: 999, fontSize: 10, fontWeight: 700,
          border: `1px solid ${selected.length ? "#E65100" : "#D1D5DB"}`,
          background: selected.length ? "#FFF3EB" : "#fff",
          color: selected.length ? "#9A3412" : "#374151",
          cursor: "pointer", whiteSpace: "nowrap", letterSpacing: 0.2,
        }}
      >{summary} ▾</button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 50,
          background: "#fff", border: "1px solid #D1D5DB", borderRadius: 8,
          boxShadow: "0 6px 18px rgba(0,0,0,0.12)", padding: 6,
          maxHeight: 260, overflowY: "auto", minWidth: 180,
        }}>
          {options.length === 0 ? (
            <div style={{ padding: "6px 10px", fontSize: 10, color: "#999", fontStyle: "italic" }}>No options</div>
          ) : options.map(opt => {
            const checked = selected.includes(opt);
            return (
              <label key={opt} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", fontSize: 11, cursor: "pointer", borderRadius: 6 }}
                onMouseEnter={e => (e.currentTarget.style.background = "#F3F4F6")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onChange(checked ? selected.filter(s => s !== opt) : [...selected, opt])}
                  style={{ margin: 0, cursor: "pointer" }}
                />
                <span style={{ color: "#1F2937" }}>{opt}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LinearFilterBar({
  filters, setFilters, options, filteredCount, totalCount, filtersActive, onClear,
}: {
  filters: LinFiltersShape;
  setFilters: React.Dispatch<React.SetStateAction<LinFiltersShape>>;
  options: { teams: string[]; projects: string[]; statuses: string[]; owners: string[]; labels: string[]; sizes: string[] };
  filteredCount: number; totalCount: number;
  filtersActive: boolean; onClear: () => void;
}) {
  const toggleArr = (key: keyof LinFiltersShape, val: string) => {
    setFilters(f => {
      const arr = (f[key] as string[]).slice();
      const i = arr.indexOf(val);
      if (i >= 0) arr.splice(i, 1); else arr.push(val);
      return { ...f, [key]: arr };
    });
  };
  return (
    <div style={{
      border: "1px solid #E5E7EB", borderRadius: 8, padding: "8px 10px",
      marginBottom: 8, background: "#FAFAF9", display: "flex", flexWrap: "wrap",
      gap: 8, alignItems: "center",
    }}>
      {/* Team chips (small set, render inline) */}
      {options.teams.length > 0 && (
        <FilterRow label="Team">
          {options.teams.map(t => (
            <FilterChip key={t} label={t} active={filters.teams.includes(t)} onClick={() => toggleArr("teams", t)} />
          ))}
        </FilterRow>
      )}

      {/* Project — dropdown (cascades from team) */}
      <FilterRow label="Project">
        <FilterDropdown label="All projects" options={options.projects} selected={filters.projects} onChange={v => setFilters(f => ({ ...f, projects: v }))} />
      </FilterRow>

      {/* Cycle */}
      <FilterRow label="Cycle">
        {(["all", "current", "next", "none"] as const).map(c => (
          <FilterChip key={c} label={c === "all" ? "All" : c === "current" ? "Current" : c === "next" ? "Next" : "No cycle"}
            active={filters.cycle === c} onClick={() => setFilters(f => ({ ...f, cycle: c }))} />
        ))}
      </FilterRow>

      {/* Status */}
      <FilterRow label="Status">
        {options.statuses.map(s => (
          <FilterChip key={s} label={s} active={filters.statuses.includes(s)} onClick={() => toggleArr("statuses", s)} />
        ))}
      </FilterRow>

      {/* Priority */}
      <FilterRow label="Priority">
        {(["high", "mid", "low"] as const).map(p => (
          <FilterChip key={p} label={p === "high" ? "High" : p === "mid" ? "Mid" : "Low"}
            active={filters.priorities.includes(p)} onClick={() => toggleArr("priorities", p)} />
        ))}
      </FilterRow>

      {/* Owner — dropdown (long list) */}
      <FilterRow label="Owner">
        <FilterDropdown label="All owners" options={options.owners} selected={filters.owners} onChange={v => setFilters(f => ({ ...f, owners: v }))} />
      </FilterRow>

      {/* Due */}
      <FilterRow label="Due">
        {(["all", "overdue", "today", "this-week", "no-date"] as const).map(d => (
          <FilterChip key={d} label={d === "all" ? "All" : d === "overdue" ? "Overdue" : d === "today" ? "Today" : d === "this-week" ? "This Week" : "No date"}
            active={filters.due === d} onClick={() => setFilters(f => ({ ...f, due: d }))} />
        ))}
      </FilterRow>

      {/* Size + Labels */}
      {options.sizes.length > 0 && (
        <FilterRow label="Size">
          {options.sizes.map(s => (
            <FilterChip key={s} label={s} active={filters.sizes.includes(s)} onClick={() => toggleArr("sizes", s)} />
          ))}
        </FilterRow>
      )}
      {options.labels.length > 0 && (
        <FilterRow label="Labels">
          <FilterDropdown label="All labels" options={options.labels} selected={filters.labels} onChange={v => setFilters(f => ({ ...f, labels: v }))} />
        </FilterRow>
      )}

      {/* Search */}
      <input
        type="text"
        placeholder="🔍 Search task or ID…"
        value={filters.search}
        onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
        style={{
          padding: "4px 10px", borderRadius: 8, fontSize: 11,
          border: "1px solid #D1D5DB", background: "#fff", color: "#1F2937",
          minWidth: 180, flex: "1 1 180px",
        }}
      />

      {/* Count + Clear */}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "#4B5563", whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 600 }}>Showing {filteredCount} of {totalCount}</span>
        {filtersActive && (
          <button onClick={onClear} style={{
            padding: "3px 10px", borderRadius: 999, fontSize: 10, fontWeight: 700,
            border: "1px solid #E65100", background: "#fff", color: "#9A3412",
            cursor: "pointer", letterSpacing: 0.2,
          }}>Clear all</button>
        )}
      </div>
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}:</span>
      <div style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
function formatRelativeTime(d: Date | null | undefined): string {
  if (!d) return "never";
  const ms = Date.now() - new Date(d).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `~${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `~${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `~${day}d ago`;
}

export function DashboardView({ tasks, tDone, calendarData, emailsImportant, linearItems, slackItems = [], contacts, calls = [], emailsLoaded = true, briefLoaded = true, lastEmailAiAt, onComplete, onNavigate, onOpenEmail, onAttempt, onCompose, onContactUpdated }: Props) {
  const [localTasks, setLocalTasks] = useState<LocalTask[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const [hoveredLin, setHoveredLin] = useState<LinearItem | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // ── Linear table filter state ────────────────────────────────────
  // All multi-select arrays use [] = "no filter" (i.e. show everything).
  // Default Status keeps the historical view: only "In Progress" + "In QA".
  const [linFilters, setLinFilters] = useState<{
    teams: string[];        // teamKey list
    projects: string[];     // projectName list
    cycle: "all" | "current" | "next" | "none";
    statuses: string[];     // l.state list
    owners: string[];       // l.who list
    priorities: string[];   // "high" | "mid" | "low"
    sizes: string[];        // "XL" | "L" | "M" | "S" | etc.
    labels: string[];
    due: "all" | "overdue" | "today" | "this-week" | "no-date";
    search: string;
  }>({
    teams: [],
    projects: [],
    cycle: "all",
    statuses: ["In Progress", "In QA"],
    owners: [],
    priorities: [],
    sizes: [],
    labels: [],
    due: "all",
    search: "",
  });

  // ── Generic hover tooltip for calls / top3 / emails ──────────────
  type HoverPayload =
    | { kind: "call"; c: Contact }
    | { kind: "task"; t: TaskItem; rank: number }
    | { kind: "email"; em: EmailItem };
  const [hovered, setHovered] = useState<HoverPayload | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const onHoverEnter = (payload: HoverPayload, e: React.MouseEvent) => {
    setHovered(payload); setHoverPos({ x: e.clientX, y: e.clientY });
  };
  const onHoverMove = (e: React.MouseEvent) => setHoverPos({ x: e.clientX, y: e.clientY });
  const onHoverLeave = () => setHovered(null);

  // ── Today's Wins — manual entries, persisted in localStorage per day ─
  const _winsKey = `tcc_wins_${new Date().toISOString().slice(0, 10)}`;
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [smsContact, setSmsContact] = useState<Contact | null>(null);

  const [wins, setWins] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(_winsKey) || '["",""]'); } catch { return ["", ""]; }
  });
  const updateWin = (i: number, val: string) => {
    setWins(prev => { const next = [...prev]; next[i] = val; localStorage.setItem(_winsKey, JSON.stringify(next)); return next; });
  };

  // ── Plan Top 3 — from 411 plan P0 tasks ──────────────────────────
  type PlanTask = { id: string; title: string; category: string; subcategory?: string | null; owner?: string | null; priority?: string | null; sprintId?: string; status?: string | null; dueDate?: string | null; };
  const [planTop3, setPlanTop3] = useState<PlanTask[]>([]);
  const [planTop3Loading, setPlanTop3Loading] = useState(true);

  const loadPlanTop3 = useCallback(() => {
    setPlanTop3Loading(true);
    get("/plan/top3")
      .then((d: { tasks: PlanTask[] }) => setPlanTop3(d.tasks || []))
      .catch(() => setPlanTop3([]))
      .finally(() => setPlanTop3Loading(false));
  }, []);

  useEffect(() => {
    get<LocalTask[]>("/tasks/local").then(setLocalTasks).catch(() => {});
    loadPlanTop3();
  }, [loadPlanTop3]);

  const toggle = useCallback((id: string) => {
    setChecked(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }, []);

  const ck = (id: string) => checked.has(id);

  const completeLocalTask = async (id: string) => {
    toggle(`local-${id}`);
    await patch(`/tasks/local/${id}`, { status: "done" }).catch(() => {});
    setLocalTasks(prev => prev.filter(t => t.id !== id));
  };


  // Data — real sources only
  // Build set of contact names that have been called today (from actual call_log)
  const calledNames = new Set(calls.map(c => c.contactName.toLowerCase()));

  // Sales Calls list priority (Tony's 2026-05-16 feedback):
  //   1) Hide contacts whose follow-up date is in the FUTURE — they reappear
  //      automatically once that date is today/past, so today's list stays focused.
  //   2) Sort by status (Hot > Warm > Cold > New) AND boost contacts whose
  //      follow-up is due today/overdue to the top.
  const todayStrPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const statusWeight: Record<string, number> = { Hot: 30, Warm: 20, Cold: 10, New: 5 };
  const callList = contacts
    .filter(c => !(c.followUpDate && c.followUpDate > todayStrPT))
    .slice()
    .sort((a, b) => {
      const sa = (statusWeight[a.status ?? ""] ?? 0) + (a.followUpDate && a.followUpDate <= todayStrPT ? 15 : 0);
      const sb = (statusWeight[b.status ?? ""] ?? 0) + (b.followUpDate && b.followUpDate <= todayStrPT ? 15 : 0);
      return sb - sa;
    })
    .slice(0, 10);
  const meetings = calendarData;
  const emails   = emailsImportant.slice(0, 3);
  const todayStr    = new Date().toISOString().slice(0, 10);
  const priorityRank = (l: LinearItem) => l.level === "high" ? 0 : l.level === "mid" ? 1 : 2;
  const stateRank = (l: LinearItem) => l.state === "In Progress" ? 0 : l.state === "In QA" ? 1 : 2;

  // Sorted issue list before filters applied — used to populate the filter
  // dropdown options (so users see every project/owner/label that exists).
  const allLinItems = useMemo(
    () => [...linearItems].sort((a, b) => stateRank(a) - stateRank(b) || priorityRank(a) - priorityRank(b)),
    [linearItems],
  );

  // Apply linFilters to produce the filtered list rendered in the table.
  const linItems = useMemo(() => {
    const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);
    const sevenDaysOut = new Date(todayDate.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const search = linFilters.search.trim().toLowerCase();

    return allLinItems.filter(l => {
      if (linFilters.teams.length && !linFilters.teams.includes(l.teamKey || "")) return false;
      if (linFilters.projects.length && !linFilters.projects.includes(l.projectName || "")) return false;
      if (linFilters.statuses.length && !linFilters.statuses.includes(l.state || "")) return false;
      if (linFilters.owners.length && !linFilters.owners.includes(l.who || "")) return false;
      if (linFilters.priorities.length && !linFilters.priorities.includes(l.level)) return false;
      if (linFilters.sizes.length && !linFilters.sizes.includes(l.size || "—")) return false;
      if (linFilters.labels.length && !(l.labels || []).some(lab => linFilters.labels.includes(lab))) return false;

      if (linFilters.cycle !== "all") {
        const startsAt = l.cycleStartsAt?.slice(0, 10);
        const endsAt = l.cycleEndsAt?.slice(0, 10);
        const isCurrent = !!startsAt && !!endsAt && startsAt <= todayStr && todayStr <= endsAt;
        if (linFilters.cycle === "current" && !isCurrent) return false;
        if (linFilters.cycle === "next" && (isCurrent || !startsAt || startsAt <= todayStr)) return false;
        if (linFilters.cycle === "none" && (l.cycleNumber != null || l.cycleName)) return false;
      }

      if (linFilters.due !== "all") {
        const deadline = l.dueDate || (l.cycleEndsAt ? l.cycleEndsAt.slice(0, 10) : null);
        if (linFilters.due === "no-date" && deadline) return false;
        if (linFilters.due === "overdue" && (!deadline || deadline >= todayStr)) return false;
        if (linFilters.due === "today" && deadline !== todayStr) return false;
        if (linFilters.due === "this-week" && (!deadline || deadline > sevenDaysOut)) return false;
      }

      if (search) {
        const haystack = `${l.task || ""} ${l.identifier || l.id || ""}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }

      return true;
    });
  }, [allLinItems, linFilters, todayStr]);

  // Filter option lists — derived from the unfiltered set so dropdowns never
  // shrink to zero options when filters are active.
  const filterOptions = useMemo(() => {
    const teams = new Set<string>(), projects = new Set<string>(), statuses = new Set<string>();
    const owners = new Set<string>(), labels = new Set<string>(), sizes = new Set<string>();
    for (const l of allLinItems) {
      if (l.teamKey) teams.add(l.teamKey);
      if (l.projectName) projects.add(l.projectName);
      if (l.state) statuses.add(l.state);
      if (l.who) owners.add(l.who);
      if (l.size) sizes.add(l.size);
      for (const lab of l.labels || []) labels.add(lab);
    }
    // Project dropdown cascades — if teams are filtered, only show projects in those teams.
    const visibleProjects = new Set<string>();
    for (const l of allLinItems) {
      if (linFilters.teams.length && !linFilters.teams.includes(l.teamKey || "")) continue;
      if (l.projectName) visibleProjects.add(l.projectName);
    }
    return {
      teams: [...teams].sort(),
      projects: [...(linFilters.teams.length ? visibleProjects : projects)].sort(),
      statuses: [...statuses].sort(),
      owners: [...owners].sort(),
      labels: [...labels].sort(),
      sizes: [...sizes].sort(),
    };
  }, [allLinItems, linFilters.teams]);

  // True when any filter differs from default — controls Clear-all button visibility.
  const filtersActive =
    linFilters.teams.length > 0 ||
    linFilters.projects.length > 0 ||
    linFilters.cycle !== "all" ||
    linFilters.owners.length > 0 ||
    linFilters.priorities.length > 0 ||
    linFilters.sizes.length > 0 ||
    linFilters.labels.length > 0 ||
    linFilters.due !== "all" ||
    linFilters.search.trim() !== "" ||
    !(linFilters.statuses.length === 2 && linFilters.statuses.includes("In Progress") && linFilters.statuses.includes("In QA"));

  const clearLinFilters = () => setLinFilters({
    teams: [], projects: [], cycle: "all",
    statuses: ["In Progress", "In QA"],
    owners: [], priorities: [], sizes: [], labels: [],
    due: "all", search: "",
  });

  const wb       = computeWorkBlocks(meetings);

  // FlipIQ uses Linear cycles (sprints) as the deadline mechanism — most issues
  // have no dueDate but do have a cycle. effectiveDeadline picks dueDate when set,
  // falling back to the cycle's end date so the dashboard shows real urgency.
  const effectiveDeadline = (l: LinearItem): string | null => {
    if (l.dueDate) return l.dueDate;
    if (l.cycleEndsAt) return l.cycleEndsAt.slice(0, 10);
    return null;
  };

  // Count weekdays (Mon-Fri) between today and target — matches Linear's "8 weekdays left" display.
  const weekdaysUntil = (targetISO: string | null | undefined): number | null => {
    if (!targetISO) return null;
    const target = new Date(targetISO + (targetISO.length === 10 ? "T00:00:00" : ""));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (isNaN(target.getTime())) return null;
    let count = 0;
    const sign = target >= today ? 1 : -1;
    const cursor = new Date(today);
    while (cursor.toISOString().slice(0, 10) !== target.toISOString().slice(0, 10)) {
      cursor.setDate(cursor.getDate() + sign);
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) count += sign;
    }
    return count;
  };

  // ON TRACK label — uses cycle end date when no explicit dueDate is set.
  const trackStatus = (l: LinearItem): "overdue" | "due-today" | "due-soon" | "ok" | "no-date" => {
    const d = effectiveDeadline(l);
    if (!d) return "no-date";
    if (d < todayStr) return "overdue";
    if (d === todayStr) return "due-today";
    const threeDaysOut = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    if (d <= threeDaysOut) return "due-soon";
    return "ok";
  };

  // Cycle cell — shows "Cycle 14 · 8wd left" or just the date if only dueDate is set.
  const fmtCycle = (l: LinearItem): { label: string; sub: string; tone: "ok" | "soon" | "over" | "none" } => {
    const wd = weekdaysUntil(l.cycleEndsAt || l.dueDate);
    // Prefer custom cycle name if set, else "Cycle <n>". If neither and we only have a dueDate, label as "Due".
    const cycleLabel = l.cycleName?.trim()
      ? l.cycleName.trim()
      : l.cycleNumber != null
      ? `Cycle ${l.cycleNumber}`
      : l.dueDate
      ? "Due"
      : "—";
    let sub = "";
    let tone: "ok" | "soon" | "over" | "none" = "none";
    if (wd != null) {
      if (wd < 0) { sub = `${Math.abs(wd)}wd over`; tone = "over"; }
      else if (wd === 0) { sub = "ends today"; tone = "soon"; }
      else if (wd <= 3) { sub = `${wd}wd left`; tone = "soon"; }
      else { sub = `${wd}wd left`; tone = "ok"; }
    }
    return { label: cycleLabel, sub, tone };
  };

  // Compact date formatter — reused by hover tooltip + Ethan/Rami sub-tables.
  const fmtDue = (d: string | null | undefined): string => {
    if (!d) return "—";
    const iso = d.length > 10 ? d.slice(0, 10) : d;
    if (iso === todayStr) return "Today";
    const tmrw = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    if (iso === tmrw) return "Tmrw";
    return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "#fff" }}>
      <style>{`
        .dash-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        @media (max-width: 540px) { .dash-2col { grid-template-columns: 1fr; } }
        .dash-row-hover:hover { background: #F7F7F5 !important; }
      `}</style>

      <div style={{ width: "100%" }}>

        {/* ── Day Timeline ── real calendar data only (no sample fallback) */}
        {!briefLoaded ? (
          <div style={{ background: "#fff", border: BORDER, padding: "14px 18px", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 18, height: 18, borderRadius: 4, background: "#EEE" }} />
            <div style={{ flex: 1, display: "flex", gap: 8 }}>
              {[0, 1, 2, 3, 4].map(i => (
                <div key={i} style={{ flex: 1, height: 28, background: i % 2 === 0 ? "#F2F2F2" : "#EEE", borderRadius: 4 }} />
              ))}
            </div>
            <div style={{ fontSize: 11, color: "#999", fontStyle: "italic", whiteSpace: "nowrap" }}>Loading schedule…</div>
          </div>
        ) : (
          <DayTimeline meetings={calendarData} autoBlocks={wb.autoBlocks} onNavigate={onNavigate} />
        )}

        <div style={{ padding: "12px 20px 18px" }}>

            {/* ── SALES CALLS — 10 Today ── */}
            <SL text={`📞 Sales Calls — ${calls.length} of 10 Done`} color="#C62828" view="sales" onNavigate={onNavigate} />
            <table style={{ width: "100%", borderCollapse: "collapse", border: BORDER, marginBottom: 2 }}>
              <thead>
                <tr><TH w={22} center>✓</TH><TH w={28} center>#</TH><TH>CONTACT</TH><TH w={120}>COMPANY</TH><TH w={90}>STATUS</TH><TH>NEXT STEP</TH></tr>
              </thead>
              <tbody>
                {callList.slice(0, 10).map((c, i) => {
                  const id = `call-${i}`;
                  const done = ck(id) || calledNames.has(c.name.toLowerCase());
                  return (
                    <tr key={id} className="dash-row-hover" style={{ background: done ? "#FAFAF8" : "#fff" }}>
                      <TD center><CB id={id} checked={done} onToggle={() => toggle(id)} /></TD>
                      <TD center dim>{i + 1}</TD>
                      <TD bold strike={done}>
                        <span
                          onClick={() => c.id && setSelectedContactId(String(c.id))}
                          style={{ cursor: c.id ? "pointer" : "default", textDecoration: c.id ? "underline dotted" : "none", textUnderlineOffset: 3 }}
                          title={c.id ? "Click to view contact" : undefined}
                        >
                          {c.name}
                        </span>
                      </TD>
                      <TD small>{c.company || "—"}</TD>
                      <TD small><span style={{ color: done ? "#ccc" : (c.status === "Hot" ? "#C62828" : c.status === "Warm" ? "#B7791F" : c.status === "New" ? "#1565C0" : "#888") }}>{c.status || "—"}</span></TD>
                      <TD small dim strike={done}>{c.nextStep || "—"}</TD>
                    </tr>
                  );
                })}
                {callList.length < 10 && Array.from({ length: 10 - callList.length }).map((_, i) => (
                  <tr key={`cb-${i}`} style={{ background: "#fff" }}>
                    <TD center><CB id={`cb-blank-${i}`} checked={false} onToggle={() => {}} /></TD>
                    <TD center dim>{callList.length + i + 1}</TD>
                    <TD /><TD /><TD /><TD />
                  </tr>
                ))}
              </tbody>
            </table>

            {/* ── TOP 3 — from 411 Plan P0 tasks ── */}
            <SL text="★ Top 3 — Do These First" color="#B7791F" view="tasks" onNavigate={onNavigate} />
            <div style={{ marginBottom: 6 }}>
              {planTop3Loading ? (
                <div style={{ padding: "16px 10px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #EBEBEB", background: "#FAFAF8" }}>
                  <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid #DDD", borderTopColor: "#B7791F", animation: "dash-spin 0.7s linear infinite" }} />
                  <div style={{ fontSize: 12, color: "#888", fontStyle: "italic" }}>Loading top 3 tasks…</div>
                  <style>{`@keyframes dash-spin { to { transform: rotate(360deg); } }`}</style>
                </div>
              ) : planTop3.length === 0 ? (
                <div style={{ padding: "14px 10px", borderBottom: "1px solid #EBEBEB", background: "#FAFAF8", textAlign: "center" }}>
                  <div style={{ fontSize: 13, color: "#888" }}>No top tasks yet — set P0 priorities in the 411 plan</div>
                </div>
              ) : (
                planTop3.slice(0, 3).map((t, i) => {
                  const id = `plan-top3-${t.id}`;
                  const done = t.status === "completed" || ck(id);
                  const CAT_COLOR: Record<string, string> = { adaptation: "#B45309", sales: "#3B6D11", tech: "#185FA5", capital: "#5B3FA0", team: "#5F5E5A" };
                  const catColor = CAT_COLOR[t.category] || "#888";
                  // C9 (Tony's 2026-05-16): show the actual priority badge.
                  // Previously hardcoded "P0" but C2 made Top 3 fall back to
                  // P1 / P2 when not enough P0s exist; the badge must match.
                  const pri = (t.priority || "P0").toUpperCase();
                  const priColor = pri === "P0" ? { fg: "#B91C1C", bg: "#FEE2E2" }
                                : pri === "P1" ? { fg: "#B45309", bg: "#FEF3C7" }
                                : pri === "P2" ? { fg: "#1D4ED8", bg: "#DBEAFE" }
                                : { fg: "#555", bg: "#EEE" };
                  // C9: format due date for the row meta line.
                  const dueLabel = t.dueDate
                    ? new Date(t.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                    : null;
                  return (
                    <div key={id} className="dash-row-hover" style={{
                      display: "flex", gap: 10, alignItems: "flex-start",
                      padding: "9px 10px", borderBottom: "1px solid #EBEBEB",
                      background: i === 0 ? "#FFFBF2" : "#fff", transition: "background 0.15s",
                    }}>
                      <CB id={id} checked={done} onToggle={async () => {
                        const willComplete = !done;
                        setPlanTop3(prev => prev.map(p =>
                          p.id === t.id ? { ...p, status: willComplete ? "completed" : "active" } : p
                        ));
                        try {
                          if (willComplete) await post(`/plan/task/${t.id}/complete`, {});
                          else await post(`/plan/task/${t.id}/uncomplete`, {});
                        } catch {
                          setPlanTop3(prev => prev.map(p =>
                            p.id === t.id ? { ...p, status: willComplete ? "active" : "completed" } : p
                          ));
                        }
                        loadPlanTop3();
                      }} />
                      <div style={{
                        width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                        background: done ? "#ccc" : (i === 0 ? BLK : "#DDD"),
                        color: done ? "#aaa" : (i === 0 ? "#fff" : "#888"),
                        fontSize: 10, fontWeight: 900,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>{i + 1}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: i === 0 ? 700 : 600, color: done ? "#bbb" : BLK, textDecoration: done ? "line-through" : "none", lineHeight: 1.4 }}>
                          {t.title}
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 3, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 9, fontWeight: 800, color: priColor.fg, background: priColor.bg, borderRadius: 3, padding: "0 5px" }}>{pri}</span>
                          {t.sprintId && <span style={{ fontSize: 9, fontWeight: 800, color: catColor, background: catColor + "18", borderRadius: 4, padding: "1px 5px", fontFamily: "monospace" }}>{t.sprintId}</span>}
                          {t.subcategory && <span style={{ fontSize: 9, color: "#aaa" }}>{t.subcategory}</span>}
                          {t.owner && <span style={{ fontSize: 9, color: catColor, fontWeight: 700 }}>{t.owner}</span>}
                          {dueLabel && <span style={{ fontSize: 9, color: "#666", fontWeight: 700 }}>· due {dueLabel}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* ── MY TASKS ── */}
            {localTasks.length > 0 && (
              <>
                <SL text="My Tasks" color="#555" time={wb.tasks} view="tasks" onNavigate={onNavigate} />
                <div style={{ marginBottom: 6 }}>
                  {localTasks.map((t, i) => (
                    <div key={t.id} className="dash-row-hover" style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 10px", borderBottom: "1px solid #EBEBEB", background: "#fff" }}>
                      <CB id={`local-${t.id}`} checked={ck(`local-${t.id}`)} onToggle={() => completeLocalTask(t.id)} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: ck(`local-${t.id}`) ? "#ccc" : BLK, textDecoration: ck(`local-${t.id}`) ? "line-through" : "none" }}>{t.text}</div>
                        {t.size && <span style={{ fontSize: 9, fontWeight: 800, color: t.size === "XL" ? "#C62828" : t.size === "L" ? "#1565C0" : t.size === "M" ? "#2E7D32" : "#888", marginRight: 6 }}>{t.size}</span>}
                      </div>
                      {t.dueDate && <div style={{ fontSize: 9, color: "#aaa", flexShrink: 0 }}>Due {new Date(t.dueDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* ── PRIORITY EMAILS ── max 3 slots, empty state when 0 ── */}
            <SL text="📧 Priority Emails" color="#E65100" time={wb.emails} view="emails" onNavigate={onNavigate} />
            {emailsLoaded && (
              <div style={{ fontSize: 10, color: "#999", padding: "4px 0 6px", fontStyle: "italic" }}>
                Last AI classification {formatRelativeTime(lastEmailAiAt)}
              </div>
            )}
            {!emailsLoaded ? (
              <div style={{ border: BORDER, background: "#fff" }}>
                {[0, 1, 2].map(i => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: i < 2 ? "1px solid #EBEBEB" : "none" }}>
                    <div style={{ width: 14, height: 14, borderRadius: 3, background: "#EEE" }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ width: "30%", height: 10, background: "#EEE", borderRadius: 3, marginBottom: 6 }} />
                      <div style={{ width: "70%", height: 10, background: "#F2F2F2", borderRadius: 3 }} />
                    </div>
                    <div style={{ width: 50, height: 10, background: "#EEE", borderRadius: 3 }} />
                  </div>
                ))}
                <div style={{ padding: "8px 12px", fontSize: 11, color: "#999", textAlign: "center", fontStyle: "italic" }}>Loading emails…</div>
              </div>
            ) : emails.length === 0 ? (
              <div style={{ border: BORDER, padding: "14px 10px", background: "#FAFAF8", textAlign: "center" }}>
                <div style={{ fontSize: 13, color: "#888" }}>No important emails right now ✨</div>
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", border: BORDER }}>
                <thead>
                  <tr><TH w={22} center>✓</TH><TH w={120}>FROM</TH><TH>SUBJECT / WHY</TH><TH w={85}>ACTION</TH></tr>
                </thead>
                <tbody>
                  {emails.map((em, i) => {
                    const id = `email-${i}`;
                    const done = ck(id);
                    return (
                      <tr key={id} className="dash-row-hover" style={{ background: "#fff", cursor: "pointer" }}
                        onClick={() => onNavigate("emails")}
                        onMouseEnter={e => onHoverEnter({ kind: "email", em }, e)}
                        onMouseMove={onHoverMove}
                        onMouseLeave={onHoverLeave}
                      >
                        <TD center><CB id={id} checked={done} onToggle={ev => { ev; toggle(id); }} /></TD>
                        <TD bold strike={done}>{em.from}</TD>
                        <td style={{ padding: "6px 8px", verticalAlign: "top" }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: done ? "#bbb" : BLK, textDecoration: done ? "line-through" : "none", lineHeight: 1.4 }}>{em.subj}</div>
                          {em.why && <div style={{ fontSize: 11, color: C.mut, marginTop: 2, lineHeight: 1.4 }}>{em.why}</div>}
                        </td>
                        <TD small bold><span style={{ color: "#1565C0" }}>{em.p || "—"}</span></TD>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

          </div>

        {/* ══ DIVIDER + BACK ════════════════════════════════════════ */}
        <div style={{ borderTop: "3px solid #111", margin: "0 20px", paddingTop: 20 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            <div style={{ fontFamily: FS, fontSize: 14, fontWeight: 900, letterSpacing: 0.8, color: BLK }}>OPERATIONS & AWARENESS</div>
            <div style={{ fontSize: 9, color: "#999", fontStyle: "italic" }}>North Star: 2 deals/month/AA @ $2,500 per acquisition. Everything else is noise.</div>
          </div>
        </div>
        <div style={{ padding: "0 20px 18px" }}>

            {/* ── LINEAR — Engineering in Progress ── */}
            <SL text="⚡ Linear — Engineering in Progress" color="#E65100" />

            {/* ── Filter bar ── */}
            <LinearFilterBar
              filters={linFilters}
              setFilters={setLinFilters}
              options={filterOptions}
              filteredCount={linItems.length}
              totalCount={allLinItems.length}
              filtersActive={filtersActive}
              onClear={clearLinFilters}
            />

            <table style={{ width: "100%", borderCollapse: "collapse", border: BORDER, marginBottom: 12 }}>
              <thead>
                <tr>
                  <TH w={22} center>✓</TH>
                  <TH w={22} center>#</TH>
                  <TH w={68}>ID</TH>
                  <TH w={80}>STATUS</TH>
                  <TH>TASK</TH>
                  <TH w={64}>OWNER</TH>
                  <TH w={24} center>🚩</TH>
                  <TH w={92} center>CYCLE</TH>
                  <TH w={68} center>ON TRACK</TH>
                  <TH w={36} center>SIZE</TH>
                </tr>
              </thead>
              <tbody>
                {linItems.length === 0 && (
                  <tr><td colSpan={10} style={{ padding: "10px", fontSize: 10, color: "#bbb", fontStyle: "italic", textAlign: "center" }}>No active issues</td></tr>
                )}
                {linItems.map((l, i) => {
                  const isCompleted = l.stateType === "completed" || l.stateType === "cancelled";
                  const ts = trackStatus(l);
                  const noDue = !l.dueDate;
                  const rowBg = isCompleted ? "#F9F9F9" : l.level === "high" ? "#FFF5F5" : noDue ? "#FFFBEB" : "#fff";
                  const rowOpacity = isCompleted ? 0.55 : 1;
                  const trackColor = isCompleted ? "#999" : ts === "overdue" ? "#C62828" : ts === "due-today" ? "#E65100" : ts === "due-soon" ? "#B45309" : ts === "no-date" ? "#999" : "#2E7D32";
                  const trackLabel = isCompleted ? "— Done" : ts === "overdue" ? "✗ Overdue" : ts === "due-today" ? "🔥 Today" : ts === "due-soon" ? "⚠ Due Soon" : ts === "no-date" ? "—" : "✓ OK";
                  const flagIcon = isCompleted ? "" : l.level === "high" ? "🚩" : l.level === "mid" ? "⚠" : "";
                  const sizeColor = l.size === "XL" ? "#C62828" : l.size === "L" ? "#1565C0" : l.size === "M" ? "#2E7D32" : "#888";
                  const stateGlyph = isCompleted && l.stateType === "completed" ? "✓"
                    : isCompleted ? "✕"
                    : l.stateType === "started" ? "▷"
                    : l.stateType === "backlog" ? "·"
                    : "○";
                  const stateGlyphColor = isCompleted && l.stateType === "completed" ? "#2E7D32"
                    : isCompleted ? "#999"
                    : l.stateType === "started" ? "#2563EB"
                    : "#aaa";
                  // Match on COM-411-style identifier (preferred), falling back to the id field
                  // since the daily-brief response stuffs the identifier into id while /linear/live keeps it separate.
                  const linId = l.identifier || (l.id && !/^[0-9a-f-]{32,}$/i.test(l.id) ? l.id : "");
                  const isMentioned = !!linId && slackItems.some(s => s.message?.includes(linId));
                  const isForTony = !!(l.who?.toLowerCase().includes("tony") || l.who?.toLowerCase().includes("diaz"));
                  return (
                    <tr
                      key={`lin-${i}`}
                      className="dash-row-hover"
                      style={{ background: rowBg, opacity: rowOpacity, cursor: l.url ? "pointer" : "default" }}
                      onClick={() => l.url && window.open(l.url, "_blank", "noopener")}
                      onMouseEnter={e => { setHoveredLin(l); setTooltipPos({ x: e.clientX, y: e.clientY }); }}
                      onMouseMove={e => setTooltipPos({ x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setHoveredLin(null)}
                    >
                      <TD center>
                        <span style={{ fontSize: 13, fontWeight: 800, color: stateGlyphColor, lineHeight: 1 }}>{stateGlyph}</span>
                      </TD>
                      <TD center small dim>{isCompleted ? "" : i + 1}</TD>
                      <TD small bold>
                        {l.url
                          ? <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: "#E65100", textDecoration: "none" }}>{l.identifier || l.id}</a>
                          : <span style={{ color: "#E65100" }}>{l.identifier || l.id}</span>
                        }
                      </TD>
                      <TD small>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 10,
                          background: l.state === "In Progress" ? "#EFF6FF" : l.state === "In QA" ? "#F0FDF4" : "#F5F5F5",
                          color: l.state === "In Progress" ? "#1D4ED8" : l.state === "In QA" ? "#15803D" : "#777",
                          border: `1px solid ${l.state === "In Progress" ? "#BFDBFE" : l.state === "In QA" ? "#BBF7D0" : "#E5E7EB"}`,
                          whiteSpace: "nowrap",
                        }}>{l.state || "—"}</span>
                      </TD>
                      <TD strike={isCompleted}>
                        <span style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                          <span>{l.task}</span>
                          {isMentioned && (
                            <span style={{ fontSize: 9, fontWeight: 800, background: C.bluBg, color: C.blu, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap", letterSpacing: 0.3 }}>@ Mentioned</span>
                          )}
                          {isForTony && (
                            <span style={{ fontSize: 9, fontWeight: 800, background: C.ambBg, color: C.amb, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap", letterSpacing: 0.3 }}>Task for Tony</span>
                          )}
                        </span>
                      </TD>
                      <TD small>{l.who || "—"}</TD>
                      <TD center><span style={{ fontSize: 11 }}>{flagIcon}</span></TD>
                      <TD small center>
                        {(() => {
                          const c = fmtCycle(l);
                          if (c.tone === "none" && c.label === "—") {
                            return <span style={{ fontWeight: 700, color: "#B45309", fontSize: 9, letterSpacing: 0.3 }}>⚠ No cycle</span>;
                          }
                          const subColor = c.tone === "over" ? "#C62828" : c.tone === "soon" ? "#E65100" : c.tone === "ok" ? "#2E7D32" : "#999";
                          return (
                            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
                              <span style={{ fontWeight: 700, color: "#374151", fontSize: 10 }}>{c.label}</span>
                              {c.sub && <span style={{ fontSize: 9, fontWeight: 600, color: subColor }}>{c.sub}</span>}
                            </div>
                          );
                        })()}
                      </TD>
                      <TD small center>
                        <span style={{ fontWeight: 700, color: trackColor }}>{trackLabel}</span>
                      </TD>
                      <TD small center>
                        <span style={{ fontWeight: 800, color: sizeColor }}>{l.size || "—"}</span>
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Ethan/Rami sub-tables removed — use the Owner filter to scope by person. */}

            {/* ── TODAY'S WINS ── */}
            <SL text="🏆 Today's Wins" color="#B7791F" />
            <div style={{ border: "2px solid #B7791F33", borderRadius: 4, background: "#FFFBF2", overflow: "hidden", marginBottom: 2 }}>

              {/* Win 1 — Auto: 10 calls + appointments booked */}
              {(() => {
                const callsDone = calls.length;
                const callWin = callsDone >= 10;
                // B7 (Tony's 2026-05-16): only count real sales appointments,
                // NOT follow-up reminders. The backend now tags follow-up
                // GCal events with "Follow up:" prefix and sales appointments
                // with "Sales appt:" prefix when scheduled via the connected
                // call modal. Pre-existing manual calendar events without
                // either prefix are still counted (they could be real meetings).
                const apptCount = meetings.filter(m =>
                  !/^Follow up:/i.test(m.n || "")
                ).length;
                return (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "11px 14px", borderBottom: "1px solid #EEE4CC",
                    background: callWin ? "#F0FDF4" : "#FFFBF2",
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 900, color: callWin ? "#16A34A" : "#B7791F", width: 18, flexShrink: 0, textAlign: "center" }}>1.</span>
                    <div style={{ flex: 1 }}>
                      {callWin ? (
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#14532D" }}>
                          10 Sales Calls ✓ — {apptCount} appointment{apptCount !== 1 ? "s" : ""} booked
                        </div>
                      ) : (
                        <>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#78350F" }}>10 Sales Calls</div>
                          <div style={{ fontSize: 10, color: "#A16207", marginTop: 1 }}>
                            {callsDone} / 10 — {apptCount} appointment{apptCount !== 1 ? "s" : ""} booked so far
                          </div>
                        </>
                      )}
                    </div>
                    {callWin && <span style={{ fontSize: 10, fontWeight: 800, color: "#16A34A", letterSpacing: 0.4 }}>WIN</span>}
                  </div>
                );
              })()}

              {/* Wins 2 & 3 — manual */}
              {wins.map((val, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "11px 14px",
                  borderBottom: i === 0 ? "1px solid #EEE4CC" : "none",
                }}>
                  <span style={{ fontSize: 13, fontWeight: 900, color: "#B7791F", width: 18, flexShrink: 0, textAlign: "center" }}>
                    {i + 2}.
                  </span>
                  <input
                    value={val}
                    onChange={e => updateWin(i, e.target.value)}
                    placeholder={`Add win #${i + 2}…`}
                    style={{
                      flex: 1, border: "none", outline: "none",
                      fontSize: 12, fontWeight: val ? 600 : 400,
                      fontFamily: F, background: "transparent",
                      color: val ? "#78350F" : "#C49A3A",
                      padding: "2px 0",
                    }}
                  />
                </div>
              ))}
            </div>

          </div>

      </div>

      {/* ── GENERIC HOVER TOOLTIP (calls / top3 / emails) ── */}
      {hovered && (() => {
        const wx = typeof window !== "undefined" ? window.innerWidth : 1200;
        const style: React.CSSProperties = {
          position: "fixed",
          left: Math.min(hoverPos.x + 18, wx - 320),
          top: Math.max(hoverPos.y - 20, 8),
          zIndex: 9999,
          background: C.card,
          border: `1px solid ${C.brd}`,
          borderRadius: 8,
          padding: "12px 14px",
          width: 300,
          boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
          fontSize: 11,
          lineHeight: 1.55,
          pointerEvents: "none",
          fontFamily: F,
        };
        const Row = ({ label, val, color }: { label: string; val?: string | null; color?: string }) => val ? (
          <>
            <span style={{ color: C.mut, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
            <span style={{ color: color || C.tx }}>{val}</span>
          </>
        ) : null;

        if (hovered.kind === "call") {
          const { c } = hovered;
          const statusColor = c.status === "Hot" ? C.red : c.status === "Warm" ? C.amb : c.status === "Cold" ? C.blu : C.mut;
          return (
            <div style={style}>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.tx, marginBottom: 4 }}>{c.name}</div>
              {c.company && <div style={{ fontSize: 10, color: C.sub, marginBottom: 10 }}>{c.company}</div>}
              <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: "5px 8px", fontSize: 10.5 }}>
                <Row label="Phone" val={c.phone} />
                <span style={{ color: C.mut, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Status</span>
                <span style={{ color: statusColor, fontWeight: 700 }}>{c.status === "Hot" ? "🔴 Hot" : c.status === "Warm" ? "🟡 Warm" : c.status === "Cold" ? "🔵 Cold" : c.status || "—"}</span>
              </div>
            </div>
          );
        }

        if (hovered.kind === "task") {
          const { t, rank } = hovered;
          return (
            <div style={style}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ width: 20, height: 20, borderRadius: 4, background: rank === 1 ? "#F97316" : C.bg, color: rank === 1 ? "#fff" : C.mut, border: `1px solid ${rank === 1 ? "#F97316" : C.brd}`, fontSize: 10, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {rank}
                </div>
                {t.cat && <span style={{ fontSize: 9, fontWeight: 700, color: C.mut, letterSpacing: 0.5, textTransform: "uppercase" }}>{t.cat}</span>}
              </div>
              <div style={{ fontWeight: 700, fontSize: 13, color: C.tx, lineHeight: 1.4, marginBottom: 8 }}>{t.text}</div>
              {(t as any).dueDate && (
                <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: "5px 8px", fontSize: 10.5 }}>
                  <Row label="Due" val={(t as any).dueDate} />
                </div>
              )}
              <div style={{ marginTop: 8, fontSize: 10, color: C.mut, fontStyle: "italic" }}>
                Click checkbox to mark complete →
              </div>
            </div>
          );
        }

        if (hovered.kind === "email") {
          const { em } = hovered;
          return (
            <div style={style}>
              <div style={{ fontWeight: 700, fontSize: 13, color: C.tx, marginBottom: 4 }}>{em.from}</div>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 10, paddingBottom: 10, borderBottom: `1px solid ${C.brd}` }}>{em.subj}</div>
              <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: "5px 8px", fontSize: 10.5 }}>
                <Row label="Why" val={em.why} />
                <Row label="Action" val={em.p} color={C.blu} />
              </div>
              <div style={{ marginTop: 10, fontSize: 10, color: C.mut, fontStyle: "italic" }}>
                Click row to open Emails →
              </div>
            </div>
          );
        }

        return null;
      })()}

      {/* ── LINEAR HOVER TOOLTIP ── */}
      {hoveredLin && (
        <div
          style={{
            position: "fixed",
            left: Math.min(tooltipPos.x + 18, (typeof window !== "undefined" ? window.innerWidth : 1200) - 360),
            top: Math.max(tooltipPos.y - 20, 8),
            zIndex: 9999,
            background: C.card,
            border: `1px solid ${C.brd}`,
            borderRadius: 8,
            padding: "10px 14px",
            width: 300,
            boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
            fontSize: 11,
            lineHeight: 1.55,
            pointerEvents: "none",
            fontFamily: F,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            {hoveredLin.url
              ? <a href={hoveredLin.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, fontWeight: 800, color: C.blu, letterSpacing: 0.6, textDecoration: "none" }}>{hoveredLin.identifier || hoveredLin.id}</a>
              : <span style={{ fontSize: 10, fontWeight: 800, color: C.blu, letterSpacing: 0.6 }}>{hoveredLin.identifier || hoveredLin.id}</span>
            }
            {hoveredLin.state && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 20,
                background: hoveredLin.state === "In Progress" ? "#EFF6FF" : hoveredLin.state === "In QA" ? "#F0FDF4" : "#F5F5F5",
                color: hoveredLin.state === "In Progress" ? "#1D4ED8" : hoveredLin.state === "In QA" ? "#15803D" : C.mut,
                border: `1px solid ${hoveredLin.state === "In Progress" ? "#BFDBFE" : hoveredLin.state === "In QA" ? "#BBF7D0" : C.brd}`,
              }}>{hoveredLin.state}</span>
            )}
          </div>
          <div style={{ fontWeight: 700, fontSize: 13, color: C.tx, marginBottom: 6, lineHeight: 1.4 }}>{hoveredLin.task}</div>
          {hoveredLin.description && (() => {
            const cleanDesc = hoveredLin.description.replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
            return cleanDesc ? (
              <div style={{ fontSize: 10.5, color: C.sub, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${C.brd}`, lineHeight: 1.5 }}>
                {cleanDesc.length > 200 ? cleanDesc.slice(0, 200) + "…" : cleanDesc}
              </div>
            ) : null;
          })()}
          <div style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: "3px 8px", fontSize: 10.5 }}>
            <span style={{ color: C.mut }}>Owner</span>
            <span style={{ color: C.tx }}>{hoveredLin.who || "—"}</span>
            <span style={{ color: C.mut }}>Priority</span>
            <span style={{ color: hoveredLin.level === "high" ? C.red : hoveredLin.level === "mid" ? C.amb : C.mut, fontWeight: 600 }}>
              {hoveredLin.level === "high" ? "High" : hoveredLin.level === "mid" ? "Medium" : "Low"}
            </span>
            <span style={{ color: C.mut }}>Started</span>
            <span style={{ color: C.tx }}>{hoveredLin.startDate ? fmtDue(hoveredLin.startDate) : "—"}</span>
            <span style={{ color: hoveredLin.dueDate ? C.mut : C.amb }}>Due</span>
            <span style={{ color: hoveredLin.dueDate ? C.tx : C.amb, fontWeight: hoveredLin.dueDate ? 400 : 700 }}>
              {hoveredLin.dueDate ? fmtDue(hoveredLin.dueDate) : "⚠ No due date set"}
            </span>
            <span style={{ color: C.mut }}>Size</span>
            <span style={{ color: C.tx, fontWeight: 700 }}>{hoveredLin.size || "—"}</span>
            {hoveredLin.labels && hoveredLin.labels.length > 0 && (
              <>
                <span style={{ color: C.mut }}>Labels</span>
                <span style={{ color: C.tx }}>{hoveredLin.labels.join(", ")}</span>
              </>
            )}
          </div>
          {hoveredLin.url && (
            <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${C.brd}` }}>
              <a href={hoveredLin.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: C.blu, textDecoration: "none", fontWeight: 600 }}>
                Open in Linear ↗
              </a>
            </div>
          )}
        </div>
      )}

      {/* ── Contact Drawer (same sidebar as Sales page) ── */}
      <ContactDrawer
        contactId={selectedContactId}
        onClose={() => setSelectedContactId(null)}
        onUpdated={c => { if (onContactUpdated) onContactUpdated(c); }}
        onDeleted={() => setSelectedContactId(null)}
        onAttempt={c => { if (onAttempt) onAttempt(c); setSelectedContactId(null); }}
        onConnected={() => setSelectedContactId(null)}
        onSmsOpen={c => { setSmsContact(c); setSelectedContactId(null); }}
        onCompose={onCompose ? c => { onCompose(c); setSelectedContactId(null); } : undefined}
      />

      {/* ── SMS Modal ── */}
      {smsContact && (
        <SmsModal contact={smsContact as any} onClose={() => setSmsContact(null)} />
      )}
    </div>
  );
}
