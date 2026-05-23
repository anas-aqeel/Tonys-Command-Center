import React, { useState, useEffect, useCallback } from "react";
import { F, FS } from "./constants";
import { get, post } from "@/lib/api";
import type { TaskItem, CalItem, EmailItem, SlackItem, LinearItem } from "./types";

interface Contact { name: string; phone?: string; company?: string; nextStep?: string; status?: string; }
interface LocalTask { id: string; text: string; dueDate?: string | null; taskType?: string | null; size?: string | null; }
// Mirrors /plan/top3 response shape. Used by the print sheet's Top 3 panel
// so it matches what the dashboard renders (instead of brief.tasks, which is
// a different data source — Claude-generated daily focus items, often empty).
interface PlanTask { id: string; title: string; category: string; subcategory?: string | null; owner?: string | null; priority?: string | null; sprintId?: string; status?: string | null; dueDate?: string | null; }

// F4 (Tony's 2026-05-16): "Process Scanned Sheet" button is hidden until Tony
// asks for it back. Backend route POST /sheet-scan/process is untouched —
// flip this to true to re-surface the button without redeploy of the BE.
const SHOW_PROCESS_SCANNED_SHEET = false;

interface Props {
  tasks: TaskItem[];
  tDone: Record<string, boolean>;
  calendarData: CalItem[];
  emailsImportant: EmailItem[];
  slackItems?: SlackItem[];
  linearItems?: LinearItem[];
  topCallContacts?: Contact[];
  onClose: () => void;
  onRefresh?: () => Promise<void>;
}

const DATE_STR = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

// Strip HTML tags + decode common entities from a string (used to clean GCal
// event descriptions before rendering in the narrow PREP column on the print
// sheet — without this, raw <a href="..."> and <br> markup leaks through).
function stripHtml(s: string | null | undefined, maxLen = 90): string {
  if (!s) return "";
  // Replace <br> / </p> / </div> with a single space so words don't merge
  let out = s.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, " ");
  // Drop all other tags
  out = out.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  out = out
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  // Collapse whitespace + trim, then truncate
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > maxLen) out = out.slice(0, maxLen).trimEnd() + "…";
  return out;
}

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

function computeWorkBlocks(meetingList: CalItem[]) {
  const WORK_START = 7 * 60;
  const WORK_END = 18 * 60;
  const MIN_USEFUL = 30;
  const busy = meetingList
    .map(m => {
      const start = parseTimeMins(m.t);
      const end = m.tEnd ? parseTimeMins(m.tEnd) : (start !== null ? start + 30 : null);
      return start !== null && end !== null ? { start, end } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a!.start - b!.start) as { start: number; end: number }[];
  const free: { start: number; end: number }[] = [];
  let cursor = WORK_START;
  for (const b of busy) {
    if (b.start > cursor + MIN_USEFUL) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < WORK_END - MIN_USEFUL) free.push({ start: cursor, end: WORK_END });
  const fmt = (b: { start: number; end: number }) => `${fmtMins(b.start)} – ${fmtMins(b.end)}`;
  const morning = free.filter(b => b.start < 12 * 60 && b.end - b.start >= MIN_USEFUL);
  const afternoon = free.filter(b => b.start >= 11 * 60 && b.end - b.start >= MIN_USEFUL);
  return {
    salesCalls: morning[0] ? fmt(morning[0]) : free[0] ? fmt(free[0]) : undefined,
    tasks: morning[1] ? fmt(morning[1]) : afternoon[0] ? fmt(afternoon[0]) : undefined,
    emails: afternoon[0] ? fmt(afternoon[0]) : free[2] ? fmt(free[2]) : undefined,
  };
}

// ── Palette ──────────────────────────────────────────────────────────────────
const BLK = "#111";
const BORDER = "1px solid #bbb";
const HEAVY = "2px solid #222";
const HDR_BG = "#F2F2F2";
const PAGE_W = 780;

// ── Checkbox ─────────────────────────────────────────────────────────────────
function CB({ id, done, onToggle }: { id: string; done: boolean; onToggle: (id: string) => void }) {
  return (
    <div onClick={() => onToggle(id)} style={{
      width: 14, height: 14, border: done ? "2px solid #111" : "1.5px solid #888",
      borderRadius: 2, background: done ? "#111" : "#fff", cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    }}>
      {done && <span style={{ color: "#fff", fontSize: 9, lineHeight: 1, fontWeight: 900 }}>✓</span>}
    </div>
  );
}

// ── Table helpers ─────────────────────────────────────────────────────────────
function TH({ children, w, center }: { children: React.ReactNode; w?: number | string; center?: boolean }) {
  return (
    <th style={{
      fontSize: 8, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8,
      color: "#444", padding: "4px 6px", textAlign: center ? "center" : "left",
      background: HDR_BG, borderBottom: HEAVY, whiteSpace: "nowrap",
      width: w !== undefined ? w : undefined,
    }}>{children}</th>
  );
}

function TD({ children, center, bold, small, dim, strike, noWrap }: {
  children?: React.ReactNode; center?: boolean; bold?: boolean;
  small?: boolean; dim?: boolean; strike?: boolean; noWrap?: boolean;
}) {
  return (
    <td style={{
      fontSize: small ? 9 : 11, fontWeight: bold ? 700 : 400,
      color: dim ? "#999" : BLK, padding: "5px 6px",
      textAlign: center ? "center" : "left",
      textDecoration: strike ? "line-through" : "none",
      borderBottom: "1px solid #E8E8E8", verticalAlign: "top",
      whiteSpace: noWrap ? "nowrap" : undefined,
    }}>{children}</td>
  );
}

// ── Section label ─────────────────────────────────────────────────────────────
function SL({ text, color = "#444", time }: { text: string; color?: string; time?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, marginTop: 12 }}>
      <div style={{ fontSize: 9, fontWeight: 900, textTransform: "uppercase", letterSpacing: 1.5, color }}>{text}</div>
      {time && (
        <div style={{
          fontSize: 9, fontWeight: 700, color: "#888",
          background: "#F2F2F2", border: "1px solid #DDD", borderRadius: 4,
          padding: "1px 6px", letterSpacing: 0.3, fontFamily: "monospace",
        }}>{time}</div>
      )}
    </div>
  );
}

// ── Page wrapper ──────────────────────────────────────────────────────────────
// isPrint: skips fixed width / shadow so @page fills the paper
function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  const isPrint = className?.includes("print-page");
  return (
    <div className={className} style={{
      background: "#fff",
      width: isPrint ? "100%" : PAGE_W,
      minHeight: isPrint ? undefined : 980,
      boxShadow: isPrint ? "none" : "0 6px 32px rgba(0,0,0,0.4)",
      borderRadius: isPrint ? 0 : 3,
      overflow: "hidden",
      flexShrink: 0,
      fontFamily: F,
      fontSize: 11,
      color: BLK,
    }}>
      {children}
    </div>
  );
}

function PageHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{
      padding: "10px 18px 8px", borderBottom: HEAVY,
      display: "flex", alignItems: "center", justifyContent: "space-between",
    }}>
      <div>
        <div style={{ fontFamily: FS, fontSize: 17, fontWeight: 900, letterSpacing: 1, color: BLK }}>{title}</div>
        <div style={{ fontSize: 10, color: "#666", marginTop: 2 }}>{DATE_STR}</div>
      </div>
      <div style={{ fontSize: 9, color: "#888", fontStyle: "italic", textAlign: "right", maxWidth: 280 }}>
        "{sub}"
      </div>
    </div>
  );
}

// ── Toolbar button ────────────────────────────────────────────────────────────
function Btn({ label, onClick, disabled, primary, dim }: {
  label: string; onClick: () => void; disabled?: boolean; primary?: boolean; dim?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "7px 16px", fontSize: 12, fontWeight: 700, borderRadius: 8,
      cursor: disabled ? "default" : "pointer",
      border: primary ? "none" : "1px solid #333",
      background: primary ? "#fff" : "none",
      color: disabled ? "#555" : primary ? "#111" : dim ? "#999" : "#eee",
      fontFamily: F, opacity: disabled ? 0.5 : 1, flexShrink: 0,
    }}>{label}</button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export function PrintView({
  tasks, tDone, calendarData, emailsImportant,
  slackItems = [], linearItems = [], topCallContacts = [],
  onClose, onRefresh,
}: Props) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [inboxEmail, setInboxEmail] = useState<string>("");
  const [processing, setProcessing] = useState(false);
  const [processResult, setProcessResult] = useState<string | null>(null);
  // F1 (Tony's 2026-05-16): include the actual to-do list on the printout.
  const [localTasks, setLocalTasks] = useState<LocalTask[]>([]);
  // F1-fix: print Top 3 must read the same /plan/top3 source the dashboard uses
  // (P0→P1→P2 sort from the 411 plan). Previously the print pulled from
  // brief.tasks which is a separate Claude-generated brief surface and is
  // usually empty, so the Top 3 panel printed blank rows.
  const [planTop3, setPlanTop3] = useState<PlanTask[]>([]);

  useEffect(() => {
    get<LocalTask[]>("/tasks/local")
      .then(d => { if (Array.isArray(d)) setLocalTasks(d); })
      .catch(() => {});
    get<{ tasks: PlanTask[] }>("/plan/top3")
      .then(d => { if (d?.tasks) setPlanTop3(d.tasks); })
      .catch(() => {});
  }, []);

  const toggle = useCallback((id: string) => {
    setDone(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    // Only fetch when the scan UI is enabled — the endpoint currently 500s
    // because AgentMail was removed, so skipping when hidden avoids noisy
    // logs and saves the round-trip.
    if (SHOW_PROCESS_SCANNED_SHEET) {
      get<{ ok: boolean; email?: string }>("/sheet-scan/inbox")
        .then(r => { if (r.ok && r.email) setInboxEmail(r.email); })
        .catch(() => {});
    }
  }, []);

  const handleProcessScan = async () => {
    if (processing) return;
    setProcessing(true);
    setProcessResult(null);
    try {
      const r = await post<{ ok: boolean; callsLogged?: string[]; tasksCompleted?: number[]; confidence?: string; error?: string }>("/sheet-scan/process");
      if (r.ok) {
        const parts = [];
        if ((r.callsLogged?.length ?? 0) > 0) parts.push(`${r.callsLogged!.length} call(s) logged`);
        if ((r.tasksCompleted?.length ?? 0) > 0) parts.push(`${r.tasksCompleted!.length} task(s) marked done`);
        setProcessResult(parts.length > 0 ? `✅ Processed (${r.confidence}): ${parts.join(", ")}` : "✅ Sheet scanned — nothing checked yet");
      } else {
        setProcessResult(`⚠ ${r.error ?? "Could not process"}`);
      }
    } catch {
      setProcessResult("⚠ Error contacting server");
    } finally {
      setProcessing(false);
    }
  };

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setProcessResult(null);
    // F3 (Tony's 2026-05-16): surface clear feedback. Previously this silently
    // swallowed errors which is why Tony saw stale data + a confusing "Error
    // contacting server" message bleeding over from the Process Scanned Sheet
    // attempt that sits next to it (F4 hides that button so it can't confuse).
    // Reload local tasks too so the new To-Do section (F1) reflects edits.
    try {
      const tasksPromise = get<LocalTask[]>("/tasks/local")
        .then(d => { if (Array.isArray(d)) setLocalTasks(d); })
        .catch(() => {});
      const refreshPromise = onRefresh ? onRefresh() : Promise.resolve();
      await Promise.all([tasksPromise, refreshPromise]);
      setProcessResult("✅ Refreshed — calendar, emails, and to-dos updated");
      setTimeout(() => setProcessResult(null), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProcessResult(`⚠ Refresh failed — ${msg.slice(0, 120) || "check your connection"}`);
    } finally {
      setRefreshing(false);
    }
  };

  const ck = (id: string) => done.has(id);

  // Data
  // F1-fix: Top 3 now reads /plan/top3 (P0→P1→P2 from the 411 plan, matching
  // the dashboard) instead of brief.tasks. Filter out tasks already completed
  // locally; backend already excludes status='completed' but tDone covers the
  // optimistic "checked but not yet saved" case.
  const top3 = planTop3.filter(t => !tDone[t.id] && t.status !== "completed").slice(0, 3);
  const callList = topCallContacts.slice(0, 10);
  // F1 (Tony's 2026-05-16): include ALL calendar events on the print sheet —
  // the previous .filter(c => c.real) hid solo focus blocks, which was Tony's
  // "Missing... Today's calendar". Cap to 9 rows so it still fits the layout.
  const meetings = calendarData.slice(0, 9);
  const emails = emailsImportant.slice(0, 8);
  const linActive = linearItems.slice(0, 30);
  const slackActive = slackItems.slice(0, 8);
  // F1: filter to ACTIVE local tasks not already done; cap to 8 for the
  // back-page section so F2's 2-page constraint holds even with full Linear
  // + email + slack rows. Sort by due date ascending (no date = end).
  const todoList = localTasks
    .slice()
    .sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    })
    .slice(0, 8);
  // Filter from the FULL linearItems list (not the top-30 slice) so a person
  // whose tickets are lower-priority than the dominant assignee's still
  // surface in their column. Previously the top-30 was Rami-heavy (CX-* high-pri
  // tickets) which left zero Ethan rows in the filtered set even though Ethan
  // has plenty of active Linear issues assigned.
  const ramiItems = linearItems.filter(l => (l.who || "").toLowerCase().includes("rami") || (l.who || "").toLowerCase().includes("ramy") || (l.who || "").toLowerCase().includes("remy"));
  const ethanItems = linearItems.filter(l => (l.who || "").toLowerCase().includes("ethan"));
  const workBlocks = computeWorkBlocks(meetings);

  return (
    <div className="print-view-root" style={{
      position: "fixed", inset: 0, zIndex: 20000, background: "#1C1C1E",
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* ── Toolbar (hidden when printing) ── */}
      <div className="no-print" style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 24px", background: "#111", borderBottom: "1px solid #2a2a2a", flexShrink: 0,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FS, fontSize: 15, color: "#fff", fontWeight: 800, letterSpacing: 0.5 }}>
            FlipIQ Daily Action Sheet
          </div>
          <div style={{ fontSize: 11, color: "#777", marginTop: 1 }}>{DATE_STR}</div>
        </div>
        <Btn label={refreshing ? "Refreshing…" : "↻ Refresh"} onClick={handleRefresh} disabled={refreshing} dim />
        {/* F4 (Tony's 2026-05-16): "Process Scanned Sheet - Can hide this for now".
            Toggle here when Tony's ready to re-surface; the backend route still
            exists at POST /sheet-scan/process so handleProcessScan keeps working
            if this button comes back. */}
        {SHOW_PROCESS_SCANNED_SHEET && (
          <Btn label={processing ? "Processing…" : "📷 Process Scanned Sheet"} onClick={handleProcessScan} disabled={processing} dim />
        )}
        <Btn label="🖨 Print" onClick={() => {
          const printEl = document.querySelector('.print-only') as HTMLElement;
          if (!printEl) return;
          const root = document.getElementById('root');
          if (root) root.style.display = 'none';
          const wrapper = document.createElement('div');
          wrapper.id = 'print-wrapper';
          wrapper.innerHTML = printEl.innerHTML;
          document.body.appendChild(wrapper);
          window.print();
          document.body.removeChild(wrapper);
          if (root) root.style.display = '';
        }} primary />
        <Btn label="✕ Close" onClick={onClose} dim />
      </div>
      {processResult && (
        <div className="no-print" style={{
          padding: "8px 24px",
          background: processResult.startsWith("✅") ? "#1A3A1A" : "#3A1A1A",
          color: processResult.startsWith("✅") ? "#86efac" : "#fca5a5",
          fontSize: 12, fontFamily: F, fontWeight: 600, borderBottom: "1px solid #2a2a2a",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span>{processResult}</span>
          <button onClick={() => setProcessResult(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>✕</button>
        </div>
      )}

      {/* ── Scrollable preview area ── */}
      <div className="no-print" style={{
        flex: 1, overflow: "auto",
        display: "flex", flexDirection: "column", alignItems: "center",
        padding: "32px 24px 48px", gap: 40,
      }}>
        <label style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, fontWeight: 700, textTransform: "uppercase", fontFamily: F, alignSelf: "flex-start", marginLeft: `calc(50% - ${PAGE_W / 2}px)` }}>PAGE 1 — FRONT</label>
        <FrontPage callList={callList} top3={top3} meetings={meetings} workBlocks={workBlocks} inboxEmail={inboxEmail} ck={ck} toggle={toggle} className="no-print-shadow" />
        <label style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, fontWeight: 700, textTransform: "uppercase", fontFamily: F, alignSelf: "flex-start", marginLeft: `calc(50% - ${PAGE_W / 2}px)` }}>PAGE 2 — BACK</label>
        <BackPage linActive={linActive} ramiItems={ramiItems} ethanItems={ethanItems} emails={emails} slackActive={slackActive} workBlocks={workBlocks} ck={ck} toggle={toggle} todoList={todoList} className="no-print-shadow" />
        <div style={{ fontSize: 10, color: "#555", fontFamily: F, textAlign: "center", paddingBottom: 8 }}>
          Print → Portrait · Letter · 2 pages (front &amp; back of one sheet)
        </div>
      </div>

      {/* ── Actual print pages (only visible when printing) ── */}
      <div className="print-only" style={{ display: "none" }}>
        <FrontPage callList={callList} top3={top3} meetings={meetings} workBlocks={workBlocks} inboxEmail={inboxEmail} ck={ck} toggle={toggle} className="print-page" />
        <BackPage linActive={linActive} ramiItems={ramiItems} ethanItems={ethanItems} emails={emails} slackActive={slackActive} workBlocks={workBlocks} ck={ck} toggle={toggle} todoList={todoList} className="print-page" />
      </div>

      <style>{`
        @media print {
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          #print-wrapper .print-page {
            width: 100%;
            font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
            font-size: 11px;
            color: #111;
            background: #fff;
            padding: 0;
            margin: 0;
            box-shadow: none !important;
            border-radius: 0 !important;
            /* F2 (Tony's 2026-05-16): hard-cap each page to exactly one sheet.
               Letter portrait minus 0.4in×2 margins = 10.2in usable; we clip
               at 10.0in for a small safety buffer so overflow content never
               spills onto a 3rd page. */
            max-height: 10in;
            overflow: hidden !important;
            page-break-inside: avoid;
            break-inside: avoid-page;
          }
          #print-wrapper .print-page + .print-page {
            page-break-before: always;
            break-before: page;
          }
          /* F2: never break a table row or a section heading across pages. */
          #print-wrapper table, #print-wrapper tr { page-break-inside: avoid; break-inside: avoid; }
        }
        @page { size: letter portrait; margin: 0.4in 0.45in; }
      `}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 1 — FRONT
// Layout: [Calls — FULL WIDTH] then [Top 3 | Calendar 50/50]
// ─────────────────────────────────────────────────────────────────────────────
function FrontPage({ callList, top3, meetings, workBlocks, inboxEmail, ck, toggle, className }: {
  callList: Contact[];
  // F1-fix: was TaskItem[] (brief.tasks) — now PlanTask[] from /plan/top3 to
  // match the dashboard's Top 3 source so the print sheet isn't empty.
  top3: PlanTask[];
  meetings: CalItem[];
  workBlocks: { salesCalls?: string; tasks?: string; emails?: string };
  inboxEmail: string;
  ck: (id: string) => boolean;
  toggle: (id: string) => void;
  className?: string;
}) {
  return (
    <Page className={className}>
      <PageHeader title="FLIPIQ DAILY ACTION SHEET" sub="Follow the plan that I gave you! — God" />
      <div style={{ padding: "12px 18px" }}>

        {/* ══ CALLS — FULL WIDTH ══ */}
        <SL text="📞 Sales Calls — 10 Today" color="#C62828" time={workBlocks.salesCalls} />
        <table style={{ width: "100%", borderCollapse: "collapse", border: BORDER, marginBottom: 16 }}>
          <thead>
            <tr>
              <TH w={20} center>✓</TH>
              <TH w={16} center>#</TH>
              <TH w={160}>NAME / COMPANY</TH>
              <TH w={60} center>STATUS</TH>
              <TH w={85}>PHONE</TH>
              <TH>OUTCOME / NEXT STEP</TH>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }).map((_, i) => {
              const c = callList[i];
              const id = `call-${i}`;
              const isDone = ck(id);
              return (
                <tr key={id} style={{ height: 30, background: i % 2 === 0 ? "#fff" : "#FAFAFA" }}>
                  <TD center><CB id={id} done={isDone} onToggle={toggle} /></TD>
                  <TD center small dim>{i + 1}</TD>
                  {c ? (
                    <>
                      <td style={{ fontSize: 10, fontWeight: 700, color: isDone ? "#bbb" : BLK, padding: "4px 6px", borderBottom: "1px solid #E8E8E8", verticalAlign: "middle", textDecoration: isDone ? "line-through" : "none" }}>
                        {c.name}
                        {c.company && <div style={{ fontSize: 8, color: "#888", fontWeight: 400, lineHeight: 1.2 }}>{c.company}</div>}
                      </td>
                      <TD center small bold>
                        <span style={{ color: c.status === "Hot" ? "#C62828" : c.status === "Warm" ? "#E65100" : "#555" }}>{c.status || "—"}</span>
                      </TD>
                      <TD small dim noWrap>{c.phone || "—"}</TD>
                    </>
                  ) : (
                    <><td style={{ padding: "4px 6px", borderBottom: "1px solid #E8E8E8", width: 160 }} /><TD center /><TD /></>
                  )}
                  <td style={{ borderBottom: "1px solid #E8E8E8", verticalAlign: "bottom", padding: "0 6px 4px" }}>
                    <div style={{ borderBottom: "1px solid #CCC", width: "100%", marginBottom: 2 }} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* ══ 50/50: TOP 3 | CALENDAR ══ */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

          {/* LEFT — Top 3 */}
          <div>
            <SL text="★ Top 3 — Do These First" color="#B7791F" time={workBlocks.tasks} />
            <div style={{ border: "1.5px solid #E8D5A3", borderRadius: 4, overflow: "hidden" }}>
              {Array.from({ length: 3 }).map((_, i) => {
                const t = top3[i];
                const id = t ? `top3-${t.id}` : `top3-blank-${i}`;
                const isDone = ck(id);
                return (
                  <div key={id} style={{
                    display: "flex", gap: 8, alignItems: "flex-start",
                    padding: "9px 10px",
                    borderBottom: i < 2 ? "1px solid #EEE4CC" : "none",
                    background: i === 0 ? "#FFFBF2" : "#fff",
                    minHeight: 38,
                  }}>
                    <CB id={id} done={isDone} onToggle={toggle} />
                    <div style={{
                      width: 16, height: 16, background: i === 0 ? BLK : "#E0E0E0",
                      color: i === 0 ? "#fff" : "#888", borderRadius: 3,
                      fontSize: 9, fontWeight: 900, display: "flex", alignItems: "center",
                      justifyContent: "center", flexShrink: 0, marginTop: 1,
                    }}>{i + 1}</div>
                    <div style={{ flex: 1 }}>
                      {t ? (
                        <>
                          <div style={{
                            fontSize: 11, fontWeight: i === 0 ? 700 : 600,
                            color: isDone ? "#bbb" : BLK,
                            textDecoration: isDone ? "line-through" : "none",
                            lineHeight: 1.4,
                          }}>{t.title}</div>
                          {/* Compact meta row: priority + sprintId + owner + due date */}
                          <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 2, fontSize: 8, color: "#666", flexWrap: "wrap" }}>
                            {t.priority && <span style={{ fontWeight: 800, color: t.priority === "P0" ? "#B91C1C" : t.priority === "P1" ? "#B45309" : "#1D4ED8" }}>{t.priority}</span>}
                            {t.sprintId && <span style={{ fontFamily: "monospace" }}>{t.sprintId}</span>}
                            {t.owner && <span>· {t.owner}</span>}
                            {t.dueDate && <span>· due {new Date(t.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
                          </div>
                        </>
                      ) : (
                        <div style={{ borderBottom: "1px solid #DDD", marginTop: 10 }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Scan footer — gated by the same flag as the "Process Scanned
                Sheet" toolbar button (F4). Hidden by default because the
                underlying AgentMail integration was removed; flip
                SHOW_PROCESS_SCANNED_SHEET to true to re-enable both. The
                /sheet-scan/inbox endpoint currently throws which is why this
                row was stuck on "loading inbox…" forever. */}
            {SHOW_PROCESS_SCANNED_SHEET && (
              <div style={{
                marginTop: 12, padding: "7px 12px",
                border: "1.5px dashed #BBB", borderRadius: 4, background: "#FAFAFA",
              }}>
                <div style={{ fontSize: 8, fontWeight: 900, textTransform: "uppercase", letterSpacing: 1, color: "#888", marginBottom: 3 }}>
                  📷 Fill &amp; scan — email photo to TCC
                </div>
                <div style={{ fontSize: 9, fontWeight: 700, color: "#444", fontFamily: "monospace" }}>
                  {inboxEmail || "loading inbox…"}
                </div>
                <div style={{ fontSize: 8, color: "#888", marginTop: 2 }}>TCC reads it automatically &amp; updates your system</div>
              </div>
            )}
          </div>

          {/* RIGHT — Calendar */}
          <div>
            <SL text="📅 Today's Calendar" color="#1565C0" />
            <table style={{ width: "100%", borderCollapse: "collapse", border: BORDER }}>
              <thead>
                <tr>
                  <TH w={20} center>✓</TH>
                  <TH w={80}>TIME</TH>
                  <TH>MEETING</TH>
                  <TH w={60}>PREP</TH>
                </tr>
              </thead>
              <tbody>
                {meetings.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: "8px 6px", fontSize: 10, color: "#bbb", fontStyle: "italic", textAlign: "center" }}>No meetings today</td></tr>
                )}
                {meetings.map((m, i) => {
                  const id = `meet-${i}`;
                  const isDone = ck(id);
                  // GCal descriptions often carry HTML; clean before rendering
                  // so <a href="..."> doesn't leak as visible text. Prefer loc
                  // over note since location is usually short + already plain.
                  const prep = stripHtml(m.loc || m.note, 70);
                  return (
                    <tr key={id} style={{ background: i % 2 === 0 ? "#fff" : "#FAFAFA" }}>
                      <TD center><CB id={id} done={isDone} onToggle={toggle} /></TD>
                      <TD small bold noWrap>{m.t}{m.tEnd ? `–${m.tEnd}` : ""}</TD>
                      <td style={{
                        fontSize: 9, fontWeight: 400, color: isDone ? "#999" : BLK,
                        padding: "5px 6px", verticalAlign: "top",
                        textDecoration: isDone ? "line-through" : "none",
                        borderBottom: "1px solid #E8E8E8",
                        overflowWrap: "anywhere", wordBreak: "break-word",
                      }}>{stripHtml(m.n, 80)}</td>
                      <td style={{
                        fontSize: 9, color: "#999", padding: "5px 6px",
                        verticalAlign: "top", borderBottom: "1px solid #E8E8E8",
                        overflowWrap: "anywhere", wordBreak: "break-word",
                      }} title={m.note || m.loc || ""}>{prep}</td>
                    </tr>
                  );
                })}
                {Array.from({ length: Math.max(0, 9 - meetings.length) }).map((_, i) => (
                  <tr key={`meetblank-${i}`} style={{ background: (meetings.length + i) % 2 === 0 ? "#fff" : "#FAFAFA", height: 28 }}>
                    <TD center><CB id={`meetblank-${i}`} done={ck(`meetblank-${i}`)} onToggle={toggle} /></TD>
                    <TD /><TD /><TD />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </Page>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE 2 — BACK
// Layout: [Linear full] → [Rami | Ethan 50/50] → [Emails full] → [Slack full]
// ─────────────────────────────────────────────────────────────────────────────
function BackPage({ linActive, ramiItems, ethanItems, emails, slackActive, workBlocks, ck, toggle, todoList = [], className }: {
  linActive: LinearItem[];
  ramiItems: LinearItem[];
  ethanItems: LinearItem[];
  emails: EmailItem[];
  slackActive: SlackItem[];
  workBlocks: { salesCalls?: string; tasks?: string; emails?: string };
  ck: (id: string) => boolean;
  toggle: (id: string) => void;
  /** F1 (Tony's 2026-05-16): active local to-dos for today's print sheet. */
  todoList?: LocalTask[];
  className?: string;
}) {
  const renderPersonRows = (items: LinearItem[], prefix: string, max = 4) => {
    const rows = items.slice(0, max);
    const blanks = Math.max(0, max - rows.length);
    return (
      <>
        {rows.map((l, i) => {
          const id = `${prefix}-${i}`;
          const isDone = ck(id);
          return (
            <div key={id} style={{
              display: "flex", gap: 7, alignItems: "flex-start",
              padding: "6px 8px",
              borderBottom: (i < rows.length - 1 || blanks > 0) ? "1px solid #E8E8E8" : "none",
              background: i % 2 === 0 ? "#fff" : "#FAFAFA",
            }}>
              <CB id={id} done={isDone} onToggle={toggle} />
              <div style={{ flex: 1 }}>
                {l.url
                  ? <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 8, color: "#2563EB", fontWeight: 700, textDecoration: "none" }}>{l.identifier || l.id}</a>
                  : <div style={{ fontSize: 8, color: "#2563EB", fontWeight: 700 }}>{l.identifier || l.id}</div>
                }
                <div style={{ fontSize: 10, fontWeight: 500, color: isDone ? "#bbb" : BLK, textDecoration: isDone ? "line-through" : "none", lineHeight: 1.3 }}>{l.task}</div>
              </div>
            </div>
          );
        })}
        {Array.from({ length: blanks }).map((_, i) => (
          <div key={`${prefix}-blank-${i}`} style={{
            display: "flex", gap: 7, alignItems: "center",
            padding: "7px 8px",
            borderBottom: i < blanks - 1 ? "1px solid #E8E8E8" : "none",
            background: (rows.length + i) % 2 === 0 ? "#fff" : "#FAFAFA",
          }}>
            <CB id={`${prefix}-blank-${i}`} done={false} onToggle={toggle} />
            <div style={{ flex: 1, height: 1, background: "#E8E8E8" }} />
          </div>
        ))}
      </>
    );
  };

  return (
    <Page className={className}>
      <PageHeader title="OPERATIONS & AWARENESS" sub="North Star: 2 deals/month/AA @ $2,500 per acquisition. Everything else is noise." />
      <div style={{ padding: "10px 18px" }}>

        {/* ══ TO-DOS — full width (F1: Tony's 2026-05-16 ask) ══ */}
        {todoList.length > 0 && (
          <>
            <SL text={`✅ Today's To-Dos · ${todoList.length} open`} color="#16A34A" />
            <table style={{ width: "100%", borderCollapse: "collapse", border: BORDER, marginBottom: 10 }}>
              <thead>
                <tr>
                  <TH w={20} center>✓</TH>
                  <TH>TASK</TH>
                  <TH w={80}>DUE</TH>
                  <TH w={60}>TYPE</TH>
                  <TH w={50}>SIZE</TH>
                </tr>
              </thead>
              <tbody>
                {todoList.map((t, i) => {
                  const id = `todo-${t.id}`;
                  const isDone = ck(id);
                  return (
                    <tr key={id} style={{ background: i % 2 === 0 ? "#fff" : "#FAFAFA" }}>
                      <TD center><CB id={id} done={isDone} onToggle={toggle} /></TD>
                      <TD strike={isDone} small>{t.text}</TD>
                      <TD small dim noWrap>{t.dueDate || "—"}</TD>
                      <TD small dim>{t.taskType || "—"}</TD>
                      <TD small dim>{t.size || "—"}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {/* ══ LINEAR — FULL WIDTH ══ */}
        <SL text="⚡ Linear — Engineering in Progress" color="#2563EB" />
        <table style={{ width: "100%", borderCollapse: "collapse", border: BORDER, marginBottom: 10 }}>
          <thead>
            <tr>
              <TH w={20} center>✓</TH>
              <TH w={70}>ID</TH>
              <TH>TASK</TH>
              <TH w={90}>OWNER</TH>
              <TH w={80}>STATUS</TH>
            </tr>
          </thead>
          <tbody>
            {linActive.length === 0 && (
              <tr><td colSpan={5} style={{ padding: "8px 6px", fontSize: 10, color: "#bbb", fontStyle: "italic", textAlign: "center" }}>No active Linear issues</td></tr>
            )}
            {linActive.map((l, i) => {
              const id = `linear-${i}`;
              const isDone = ck(id);
              const isHigh = l.level === "high";
              return (
                <tr key={id} style={{ background: i % 2 === 0 ? "#fff" : "#FAFAFA" }}>
                  <TD center><CB id={id} done={isDone} onToggle={toggle} /></TD>
                  <TD small bold>
                    {l.url
                      ? <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: "#2563EB", textDecoration: "none" }}>{l.identifier || l.id}</a>
                      : <span style={{ color: "#2563EB" }}>{l.identifier || l.id}</span>
                    }
                  </TD>
                  <TD strike={isDone} small>{l.task}</TD>
                  <TD small>{l.who || "—"}</TD>
                  <TD small>
                    <span style={{ color: isHigh ? "#C62828" : l.level === "mid" ? "#E65100" : "#555", fontWeight: isHigh ? 700 : 400 }}>
                      {isHigh ? "🔴 High" : l.level === "mid" ? "⚠ Mid" : "Low"}
                    </span>
                  </TD>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* ══ RAMI | ETHAN — 50/50 ══ */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 10 }}>
          <div>
            <SL text="👤 Rami — Tasks" color="#555" />
            <div style={{ border: BORDER, borderRadius: 2, overflow: "hidden" }}>
              {renderPersonRows(ramiItems, "rami")}
            </div>
          </div>
          <div>
            <SL text="👤 Ethan — Tasks" color="#555" />
            <div style={{ border: BORDER, borderRadius: 2, overflow: "hidden" }}>
              {renderPersonRows(ethanItems, "ethan")}
            </div>
          </div>
        </div>

        {/* ══ EMAILS — FULL WIDTH ══ */}
        <SL text="📧 Priority Emails" color="#E65100" time={workBlocks.emails} />
        <table style={{ width: "100%", borderCollapse: "collapse", border: BORDER, marginBottom: 10 }}>
          <thead>
            <tr>
              <TH w={20} center>✓</TH>
              <TH w={140}>FROM</TH>
              <TH>SUBJECT</TH>
              <TH w={50} center>PRI</TH>
              <TH w={160}>ACTION / REPLY NOTES</TH>
            </tr>
          </thead>
          <tbody>
            {emails.map((e, i) => {
              const id = `email-${i}`;
              const isDone = ck(id);
              return (
                <tr key={id} style={{ background: i % 2 === 0 ? "#fff" : "#FAFAFA" }}>
                  <TD center><CB id={id} done={isDone} onToggle={toggle} /></TD>
                  <TD bold strike={isDone} small>{e.from}</TD>
                  <TD strike={isDone} small>{e.subj}</TD>
                  <TD center small bold>
                    <span style={{ color: e.p === "high" ? "#C62828" : e.p === "med" ? "#E65100" : "#555" }}>{e.p || "—"}</span>
                  </TD>
                  <td style={{ borderBottom: "1px solid #E8E8E8", verticalAlign: "bottom", padding: "0 6px 4px" }}>
                    <div style={{ borderBottom: "1px solid #CCC", width: "100%", marginBottom: 2 }} />
                  </td>
                </tr>
              );
            })}
            {Array.from({ length: Math.max(0, 5 - emails.length) }).map((_, i) => (
              <tr key={`emailblank-${i}`} style={{ background: (emails.length + i) % 2 === 0 ? "#fff" : "#FAFAFA", height: 28 }}>
                <TD center><CB id={`emailblank-${i}`} done={ck(`emailblank-${i}`)} onToggle={toggle} /></TD>
                <TD /><TD /><TD />
                <td style={{ borderBottom: "1px solid #E8E8E8" }} />
              </tr>
            ))}
          </tbody>
        </table>

        {/* ══ SLACK — FULL WIDTH ══ */}
        <SL text="💬 Slack — Tasks & Mentions" color="#611f69" />
        <table style={{ width: "100%", borderCollapse: "collapse", border: BORDER }}>
          <thead>
            <tr>
              <TH w={20} center>✓</TH>
              <TH w={80} center>LEVEL</TH>
              <TH w={100}>CHANNEL</TH>
              <TH w={120}>FROM</TH>
              <TH>MESSAGE</TH>
              <TH w={140}>NOTES</TH>
            </tr>
          </thead>
          <tbody>
            {slackActive.length === 0 && (
              <tr><td colSpan={6} style={{ padding: "8px 6px", fontSize: 10, color: "#bbb", fontStyle: "italic", textAlign: "center" }}>No Slack items today 🎉</td></tr>
            )}
            {slackActive.map((s, i) => {
              const id = `slack-${i}`;
              const isDone = ck(id);
              const levelC = s.level === "high" ? "#C62828" : s.level === "mid" ? "#E65100" : "#555";
              return (
                <tr key={id} style={{ background: s.level === "high" ? "#FFF5F5" : i % 2 === 0 ? "#fff" : "#FAFAFA" }}>
                  <TD center><CB id={id} done={isDone} onToggle={toggle} /></TD>
                  <TD center small bold><span style={{ color: levelC, textTransform: "uppercase" }}>{s.level}</span></TD>
                  <TD small dim>{s.channel}</TD>
                  <TD small bold>{s.from}</TD>
                  <td style={{ fontSize: 9, color: isDone ? "#bbb" : "#444", padding: "5px 6px", borderBottom: "1px solid #E8E8E8", textDecoration: isDone ? "line-through" : "none", overflow: "hidden", maxWidth: 200 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.message}</div>
                  </td>
                  <td style={{ borderBottom: "1px solid #E8E8E8", verticalAlign: "bottom", padding: "0 6px 4px" }}>
                    <div style={{ borderBottom: "1px solid #CCC", width: "100%", marginBottom: 2 }} />
                  </td>
                </tr>
              );
            })}
            {Array.from({ length: Math.max(0, 4 - slackActive.length) }).map((_, i) => (
              <tr key={`slackblank-${i}`} style={{ background: (slackActive.length + i) % 2 === 0 ? "#fff" : "#FAFAFA", height: 28 }}>
                <TD center><CB id={`slackblank-${i}`} done={ck(`slackblank-${i}`)} onToggle={toggle} /></TD>
                <TD /><TD /><TD /><TD />
                <td style={{ borderBottom: "1px solid #E8E8E8" }} />
              </tr>
            ))}
          </tbody>
        </table>

      </div>
    </Page>
  );
}
