import { useState, useEffect, useCallback, useRef, type CSSProperties } from "react";
import { get, post, patch, put, del } from "@/lib/api";
import { C, F } from "@/components/tcc/constants";
import { IdeasView } from "@/components/tcc/IdeasView";
import { showTrainNowToast } from "@/lib/trainNowToast";
import { LinearAttachPicker } from "@/components/tcc/LinearAttachPicker";
import { HighlightPicker, highlightHex, HIGHLIGHT_COLORS } from "@/components/tcc/HighlightPicker";

// ─── Types ────────────────────────────────────────────────────────────────────

type PlanItem = {
  id: string;
  level: "category" | "subcategory" | "task";
  category: string;
  subcategory?: string | null;
  title: string;
  owner?: string | null;
  coOwner?: string | null;
  priority?: string | null;
  status?: string | null;
  dueDate?: string | null;
  month?: string | null;
  completedAt?: string | null;
  atomicKpi?: string | null;
  source?: string | null;
  executionTier?: string | null;
  linearId?: string | null;
  workNotes?: string | null;
  priorityOrder?: number;
  parentId?: string | null;
  sprintId?: string;
  taskType?: "master" | "subtask" | "note" | null;
  parentTaskId?: string | null;
  // Highlight feature: color marks the task as "in focus", note shows on hover.
  highlightColor?: string | null;
  highlightNote?: string | null;
  highlightAt?: string | null;
};

type SubcategoryWithTasks = PlanItem & { tasks: PlanItem[]; totalTasks: number; completedTasks: number };
type CategoryWithSubs = PlanItem & { subcategories: SubcategoryWithTasks[]; totalTasks: number; completedTasks: number };
type Tab = "goals" | "team" | "tasks" | "plan" | "ideas";

// ─── Constants ────────────────────────────────────────────────────────────────

const CAT_COLORS: Record<string, { bg: string; border: string; accent: string }> = {
  goals:      { bg: "#FFF7E1", border: "#E0CB7E", accent: "#8A6A00" },
  adaptation: { bg: "#FAEEDA", border: "#E8C78A", accent: "#B45309" },
  sales:      { bg: "#EAF3DE", border: "#9FC97A", accent: "#3B6D11" },
  tech:       { bg: "#E6F1FB", border: "#7FB3E8", accent: "#185FA5" },
  capital:    { bg: "#EEEDFE", border: "#A89CE0", accent: "#5B3FA0" },
  team:       { bg: "#F1EFE8", border: "#C4B8A8", accent: "#5F5E5A" },
};

const PERSON_COLORS: Record<string, string> = {
  tony: "#A32D2D", ethan: "#185FA5", ramy: "#3B6D11", faisal: "#BA7517",
  haris: "#534AB7", nate: "#5F5E5A", bondilyn: "#7B2D8B",
};
function personColor(name: string): string {
  const key = (name || "").toLowerCase().split(" ")[0];
  return PERSON_COLORS[key] || "#6B7280";
}

const CAT_LABELS: Record<string, string> = {
  goals: "00 Goals",
  adaptation: "01 Adaptation", sales: "02 Sales", tech: "03 Tech",
  capital: "04 Capital", team: "05 Team",
};

const TEAM_SOW = [
  {
    id: "tony", name: "Tony Diaz", role: "CEO", salary: "$5K/mo", hiring: false,
    does: [
      "Sales — 60%+ of time minimum (5 demos/week, 15+ active prospects, 3 new operators/month)",
      "Pricing & revenue model decisions",
      "Capital strategy — bridge loan vs growth loan, Kiavi broker, investor meetings",
      "AAA product spec (all agent flows, inputs, outputs, logic)",
      "Support Ramy on operator adaptation strategy",
      "OMS Owner/Operator Expectation Doc — builds then hands to Ramy",
      "Sales playbook rough drafts (investor/broker/agent/vendor) → Bondilyn refines",
      "COO Dashboard front-end prototype design",
    ],
    doesNot: [
      "Daily 8 AM operator training calls (→ Ramy owns fully)",
      "Engineering standups (→ PM when hired, then Ethan in interim)",
      "Linear ticket triage (→ PM + Ramy)",
      "Production QA / late-night debugging (→ PM + Nate SLA)",
      "Building new accountability frameworks (this doc IS the system — no mods 90 days)",
      "Customer onboarding walkthroughs (→ Ramy, OMS Layers 1–2)",
    ],
  },
  {
    id: "ethan", name: "Ethan Jolly", role: "COO / CFO", salary: "$10K/mo", hiring: false,
    does: [
      "Accountability — every task in Linear has a date, size, status, assignee. Tony never discovers a missed commitment himself.",
      "Finance & P&L — monthly burn rate, DBTM revenue tracking, Q2 model, Ramy bonus structure",
      "PM hire — job spec, sourcing, screening, offer. Non-negotiable timeline.",
      "Monday Linear status check (all tasks have dates, no orphans)",
      "Friday Tech Report (sprint delivery, blockers, SLA status, AA metrics)",
      "Suspension criteria enforcement in Linear workflow",
      "Audit Tony's calendar every Monday — is 60%+ on sales? If not, escalate.",
      "AWS cost reduction push — Ethan does not accept open-ended timelines from Nate",
    ],
    doesNot: [
      "Engineering execution",
      "Product feature decisions",
      "Sales demos or closing calls",
      "User training",
      "Creating new systems outside this doc (90-day lockdown)",
    ],
  },
  {
    id: "ramy", name: "Ramy", role: "CS Manager", salary: "$5K/mo", hiring: false,
    does: [
      "User adaptation — contact every operator, classify: active / struggling / dead weight",
      "Weekly adaptation report to Ethan every Friday (operator health, AA activation %)",
      "Autotracker training for all active operators — Tony trains once, Ramy owns everything after",
      "OMS onboarding — Layers 1–3 for all new operators",
      "10DLC compliance check and resolution for all operators",
      "Feature adoption dashboard — 14-day non-use triggers, disengagement alerts (3+ zero-activity days)",
      "Client Status Checklist (Level 1: Onboarding Started / Level 2: System Usable / Level 3: System Optimized)",
    ],
    doesNot: [
      "Engineering tickets (→ Faisal + Haris via Linear)",
      "Sales calls or demos",
      "Billing, finance, or payment disputes",
      "Changing feature behavior in production",
      "Suspension decisions alone (→ Tony + Ethan must approve)",
    ],
  },
  {
    id: "faisal", name: "Faisal Nazik", role: "Command Engineer", salary: "$3K/mo", hiring: false,
    does: [
      "Command dashboard sprint delivery — COO view, MyStats tab, Template Health tab",
      "QA completion each sprint — zero open Critical/High bugs at sprint close",
      "40+ story points per sprint cycle minimum — no punts",
      "SMS compliance UI and feature registration in phase matrix",
      "Bugs and adaptation-related fixes through April (no new improvements until PM hired)",
    ],
    doesNot: [
      "Foundation or data layer (→ Haris owns)",
      "User training or operator communication",
      "Sprint planning (→ PM when hired, → Ethan in interim)",
      "Direct operator communication",
      "AWS infrastructure",
    ],
  },
  {
    id: "haris", name: "Haris Aqeel", role: "Foundation Engineer", salary: "$2K/mo", hiring: false,
    does: [
      "Foundation — MLS accuracy, agent pipeline stability, data sync reliability",
      "DispoPro integration into Command (first week April milestone)",
      "Agent contact matching — close the 15% gap",
      "Cross-platform infrastructure audit",
      "CSM items and foundation ticket delivery",
    ],
    doesNot: [
      "Command-only UI features (→ Faisal)",
      "Sprint planning",
      "Customer or operator communication",
      "AWS management",
      "New feature design",
    ],
  },
  {
    id: "nate", name: "Nate Worcester", role: "CTO Advisory (SLA)", salary: "$6K/mo", hiring: false,
    does: [
      "AWS cost reduction — hard start/end date required, currently $5K/mo (unacceptable)",
      "Architecture reviews — estimate-first / approve-first / bill-after structure",
      "Foundation knowledge transfer to Haris — scoped, dated, no open-ended timeline",
      "Google Cloud migration architecture review",
      "SLA: Architecture questions 24hr | Production blockers 4hr | Feature specs 48hr",
      "AAA into Command Light v2.0 review and integration design",
      "Tony approves ALL scopes in writing before work begins",
    ],
    doesNot: [
      "Day-to-day engineering management",
      "Ticket triage",
      "Code without written Tony approval",
      "Customer or operator interaction",
      "Open-ended timelines — Ethan enforces hard dates",
    ],
  },
  {
    id: "bondilyn", name: "Bondilyn Jolly", role: "Marketing / Sales Support", salary: "$5K/mo", hiring: false,
    does: [
      "Sales presentation and pitch deck refinement (all 4 tiers: investor/broker/agent/vendor)",
      "USale Seller Direct script writing",
      "Outreach databases — Wealthwise, KW, qualified prospect lists",
      "Podcast and video scripts (Jessica Nieto records intro video for buyer outreach)",
      "Affiliate playbook v1",
    ],
    doesNot: [
      "Direct sales or closing calls (→ Tony)",
      "Engineering",
      "Customer success",
      "Finance",
      "Operations management",
    ],
  },
  {
    id: "tbdpm", name: "TBD — PM/Engineer", role: "PM / Engineer", salary: "$6K/mo", hiring: true,
    does: [
      "Linear workspace audit — Week 1 gate (sprint plan delivered by April 7)",
      "Daily standups with engineering team (Faisal, Haris)",
      "COO Dashboard backend features",
      "AAA build ownership — starts Day 1, completes end of May",
      "Single written weekly update to Tony only — no daily check-ins after Week 4",
    ],
    doesNot: [
      "Customer success",
      "Sales or demos",
      "Strategy decisions",
      "Daily Tony check-ins after Week 4",
      "Priority changes without Ethan approval",
    ],
  },
  {
    id: "tbdonboard", name: "TBD — Onboarding Manager", role: "Onboarding Manager", salary: "$2.5K/mo", hiring: true,
    does: [
      "Operator intake and OMS checklist execution",
      "First-contact quality control and activation",
      "Escalate issues to Ramy per defined escalation path",
      "Cross-train with CS team to eliminate single points of failure",
      "Track and report onboarding completion rates",
    ],
    doesNot: ["Ongoing support (→ Ramy)", "Sales", "Engineering", "Billing", "Suspension decisions"],
  },
  {
    id: "tbdam", name: "TBD — Adaptation Manager", role: "Adaptation Manager", salary: "$2.5K/mo", hiring: true,
    does: [
      "Feature adoption tracking per operator",
      "Disengagement alerts and proactive outreach to at-risk operators",
      "Training sessions on feature usage",
      "Weekly adoption data report to Ramy",
    ],
    doesNot: ["Onboarding (→ Onboarding Manager)", "Sales", "Engineering", "Suspension decisions", "Direct AM communication"],
  },
];

const GAP_ANALYSIS = [
  { n: 1, text: "No PM. Tony loses 20–30% of sales time to engineering overhead every week. At $100K/month target, this is a $20–30K/month gap in capacity." },
  { n: 2, text: "Ramy is a single point of failure. All CS, onboarding, and adaptation stops when he's unavailable. Zero backup." },
  { n: 3, text: "Nate's 29 issues orphaned since Mar 6. Several are P0 tech debt. No clear owner. Ethan must get hard dates this week." },
  { n: 4, text: "No sales support. Tony does demos, pitches, AND closes alone. Bondilyn supports materials but Tony has zero sales leverage." },
  { n: 5, text: "DBTM revenue not tracked. 2 acquisitions/week happening but $0 appears in the April P&L. This is unaccounted revenue." },
];

const APRIL_WEEKS = [
  { n: 1, label: "Wk 1", dates: "Apr 7–11" },
  { n: 2, label: "Wk 2", dates: "Apr 14–18" },
  { n: 3, label: "Wk 3", dates: "Apr 21–25" },
  { n: 4, label: "Wk 4", dates: "Apr 28–30" },
];

/** Generate 4 week options starting from the week containing the given date (or today) */
function getWeeksForDate(dateStr?: string): { n: number; label: string; dates: string }[] {
  const d = dateStr ? new Date(dateStr + "T12:00:00") : new Date();
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "America/Los_Angeles" });
  // Find the Monday of the week containing d
  const day = d.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(d); monday.setDate(d.getDate() + mondayOffset);
  // First day of month
  const firstOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  const firstMonday = new Date(firstOfMonth);
  const fDay = firstOfMonth.getDay();
  firstMonday.setDate(firstOfMonth.getDate() + (fDay === 0 ? 1 : fDay === 1 ? 0 : 8 - fDay));
  // Which week of the month is this?
  const weekOfMonth = Math.max(1, Math.ceil((monday.getDate()) / 7));
  const weeks: { n: number; label: string; dates: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const wkStart = new Date(monday); wkStart.setDate(monday.getDate() + i * 7);
    const wkEnd = new Date(wkStart); wkEnd.setDate(wkStart.getDate() + 4);
    const wkMon = wkStart.toLocaleString("en-US", { month: "short", timeZone: "America/Los_Angeles" });
    weeks.push({
      n: weekOfMonth + i,
      label: `Wk ${weekOfMonth + i}`,
      dates: `${wkMon} ${wkStart.getDate()}–${wkEnd.getDate()}`,
    });
  }
  return weeks;
}

const CAT_KEYS = ["goals", "adaptation", "sales", "tech", "capital", "team"];
const OWNER_OPTIONS = ["Tony", "Ethan", "Ramy", "Faisal", "Haris", "Nate", "Bondilyn", "Chris", "TBD PM"];
const PRIORITY_OPTS = [
  { value: "P0", label: "P0 — Critical. Blocks revenue or AA performance today." },
  { value: "P1", label: "P1 — High priority. Must ship this week." },
  { value: "P2", label: "P2 — Standard. Complete this sprint." },
];
const TIER_OPTS = ["Sprint", "Strategic", "Maintenance"];
const SOURCE_OPTS = ["OAP", "Linear", "TCC", "manual"];

// ─── Mini components ──────────────────────────────────────────────────────────

function ProgressBar({ done, total, color }: { done: number; total: number; color?: string }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div style={{ background: "#e5e7eb", borderRadius: 4, height: 5, flex: 1, marginLeft: 8 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color || C.grn, borderRadius: 4, transition: "width 0.4s" }} />
    </div>
  );
}

function PriorityBadge({ p }: { p: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    P0: { bg: "#FEE2E2", color: "#B91C1C" }, P1: { bg: "#FFF3E0", color: "#B45309" },
    P2: { bg: "#FEFCE8", color: "#A16207" }, High: { bg: "#FFF3E0", color: "#B45309" }, Low: { bg: "#F3F4F6", color: "#6B7280" },
  };
  const s = map[p] || { bg: "#F3F4F6", color: "#6B7280" };
  return <span style={{ fontSize: 10, fontWeight: 700, background: s.bg, color: s.color, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>{p}</span>;
}

function StatusPill({ s }: { s: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    active:    { bg: C.bluBg, color: C.blu, label: "active" },
    completed: { bg: C.grnBg, color: C.grn, label: "done ✓" },
    late:      { bg: C.redBg, color: C.red, label: "late" },
    blocked:   { bg: C.ambBg, color: C.amb, label: "blocked" },
  };
  const st = map[s] || { bg: "#F3F4F6", color: "#6B7280", label: s };
  return <span style={{ fontSize: 10, fontWeight: 700, background: st.bg, color: st.color, borderRadius: 10, padding: "1px 8px", whiteSpace: "nowrap" }}>{st.label}</span>;
}

function Toast({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  useEffect(() => { const t = setTimeout(onDismiss, 4000); return () => clearTimeout(t); }, [onDismiss]);
  return (
    <div onClick={onDismiss} style={{
      position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
      background: "#1e293b", color: "#fff", borderRadius: 10, padding: "12px 22px",
      fontSize: 13, fontWeight: 600, fontFamily: F, zIndex: 9999, cursor: "pointer",
      boxShadow: "0 8px 32px rgba(0,0,0,0.25)", maxWidth: 400, textAlign: "center",
    }}>{msg}</div>
  );
}

// ─── Task checkbox row ────────────────────────────────────────────────────────

function TaskRow({ task, onToggle }: { task: PlanItem; onToggle: (id: string, complete: boolean) => void }) {
  const done = task.status === "completed";
  const isLate = !done && task.dueDate && new Date(task.dueDate) < new Date("2026-04-09");
  const pc = personColor(task.owner || "");
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", borderBottom: `1px solid ${C.brd}`, opacity: done ? 0.6 : 1 }}>
      <button
        onClick={() => onToggle(task.id, !done)}
        style={{
          width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${done ? C.grn : "#d1d5db"}`,
          background: done ? C.grn : "transparent", color: "#fff", fontSize: 9, flexShrink: 0,
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 2,
        }}
      >{done ? "✓" : ""}</button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: done ? C.mut : isLate ? C.red : C.tx, textDecoration: done ? "line-through" : "none", fontFamily: F, lineHeight: 1.4 }}>
          {task.title}
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 2, alignItems: "center" }}>
          {task.owner && <span style={{ fontSize: 10, fontWeight: 700, color: pc, background: pc + "18", borderRadius: 8, padding: "0 6px" }}>{task.owner}</span>}
          {task.dueDate && <span style={{ fontSize: 10, color: isLate ? C.red : C.mut }}>{isLate ? "⚠ " : ""}{task.dueDate}</span>}
          {task.priority && <PriorityBadge p={task.priority} />}
        </div>
      </div>
    </div>
  );
}

// ─── GPS Cards ────────────────────────────────────────────────────────────────

function GPSCards() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
      <div style={{ background: "#FFF8E7", border: "1px solid #F6C04A", borderRadius: 10, padding: "12px 16px" }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#B45309", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, fontFamily: F }}>⚡ Atomic KPI — North Star</div>
        <div style={{ fontSize: 13, color: "#92400E", fontFamily: F, lineHeight: 1.5 }}>
          Every Acquisition Associate closes <strong>2 deals per month.</strong><br />
          Each operator has 4 full-time AAs. If it does not move an AA toward 2 deals/month — <strong>it is noise.</strong>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ background: "#FFF0F0", border: "1px solid #FCA5A5", borderRadius: 10, padding: "12px 16px" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#B91C1C", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, fontFamily: F }}>🎯 5-Year BAG</div>
          <div style={{ fontSize: 12, color: "#7F1D1D", fontFamily: F, lineHeight: 1.5 }}>
            USale Marketplace = largest off-market RE platform.<br />
            375 operators × 5 users = 1,875 users, 75 metros.<br />
            <strong>$1 BILLION exit.</strong>
          </div>
        </div>
        <div style={{ background: "#F5F0FF", border: "1px solid #C4B5FD", borderRadius: 10, padding: "12px 16px" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#6D28D9", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, fontFamily: F }}>📍 3-Year Milestone</div>
          <div style={{ fontSize: 12, color: "#4C1D95", fontFamily: F, lineHeight: 1.5 }}>
            375 operators · $1.5M/mo run rate<br />
            $16.2M cumulative · 75 metros<br />
            Command 2.0 + AAA deployed
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Category Grid — 2-column, numbered subcategories 1-5 ────────────────────

function CategoryGrid({
  categories,
  onCategoryClick,
}: {
  categories: CategoryWithSubs[];
  onToggleTask: (id: string, complete: boolean) => void;
  /** E1 (Tony's 2026-05-16): jump to master task list filtered to this category. */
  onCategoryClick?: (categoryKey: string) => void;
}) {
  if (categories.length === 0) {
    return <div style={{ textAlign: "center", padding: "48px", color: C.mut, fontFamily: F }}>Loading…</div>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 48px", marginBottom: 32 }}>
      {categories.map((cat) => {
        const slots = Array.from({ length: 5 }, (_, i) => cat.subcategories[i] || null);
        const colorKey = (cat.category || "") as keyof typeof CAT_COLORS;
        const colors = CAT_COLORS[colorKey] || { accent: "#00007A" };
        const accent = colors.accent;
        const catPct = cat.totalTasks > 0 ? Math.round((cat.completedTasks / cat.totalTasks) * 100) : 0;
        const clickable = !!onCategoryClick;
        const handleJump = () => { if (cat.category && onCategoryClick) onCategoryClick(cat.category); };

        return (
          <div key={cat.id} style={{ marginBottom: 32 }}>
            {/* Category title + stats — click anywhere on title row to drill in (E1) */}
            <div
              style={{
                display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4,
                cursor: clickable ? "pointer" : "default",
              }}
              onClick={clickable ? handleJump : undefined}
              title={clickable ? "Open Master Task List filtered to this category" : undefined}
            >
              <div style={{
                fontSize: 22, fontWeight: 800, color: accent, fontFamily: F,
                display: "inline-flex", alignItems: "baseline", gap: 6,
              }}>
                {cat.title}
                {clickable && <span style={{ fontSize: 10, opacity: 0.6, fontWeight: 600 }}>↗</span>}
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: accent, fontFamily: F, opacity: 0.85, whiteSpace: "nowrap", marginLeft: 8 }}>
                {cat.completedTasks}/{cat.totalTasks} · {catPct}% done
              </span>
            </div>
            {/* Thick underline in category color */}
            <div style={{ height: 3, background: accent, marginBottom: 8 }} />

            {/* Numbered slots 1-5 */}
            {slots.map((sub, i) => {
              const done = sub?.status === "completed";
              const subPct = sub ? (sub.totalTasks > 0 ? Math.round((sub.completedTasks / sub.totalTasks) * 100) : 0) : null;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #ccc", padding: "5px 0", minHeight: 28 }}>
                  <span style={{ fontSize: 12, color: "#999", width: 14, flexShrink: 0, fontFamily: F }}>{i + 1}</span>
                  {sub ? (
                    <>
                      <span style={{
                        fontSize: 13, color: accent, fontFamily: F,
                        textDecoration: done ? "line-through" : "none",
                        fontWeight: 500, flex: 1,
                      }}>
                        {sub.title}
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: accent, fontFamily: F, opacity: 0.75, whiteSpace: "nowrap", flexShrink: 0 }}>
                        {sub.completedTasks}/{sub.totalTasks} · {subPct}%
                      </span>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ─── Weekly Grid — original design: rotated name left, 4 week columns ─────────

const ROWS_PER_PERSON = 5;

// Category → solid color (text / border)
const CAT_COLOR: Record<string, string> = {
  adaptation: "#92400E",
  sales:      "#166534",
  tech:       "#1D4ED8",
  capital:    "#6D28D9",
  team:       "#374151",
};

function WeeklyGrid({ byOwner, childStats, onToggleTask, onTaskClick }: {
  byOwner: Record<string, Record<number, PlanItem[]>>;
  childStats?: Record<string, { total: number; done: number }>;
  onToggleTask: (id: string, complete: boolean) => void;
  onTaskClick?: (task: PlanItem) => void;
}) {
  const ORDERED = ["Tony", "Ethan", "Ramy", "Faisal", "Haris", "Nate", "Bondilyn"];
  const [showUnfinishedOnly, setShowUnfinishedOnly] = useState(true);

  // Filter the board:
  // 1. Only master tasks (no subs/notes on the weekly board)
  // 2. If showUnfinishedOnly: drop completed tasks
  // 3. Sort each cell by priority (P0 → P1 → P2) so the most critical tasks surface first
  const priorityRank = (p?: string | null) => p === "P0" ? 0 : p === "P1" ? 1 : 2;
  const filteredByOwner: Record<string, Record<number, PlanItem[]>> = {};
  const originalCountsByOwner: Record<string, Record<number, number>> = {};
  for (const [owner, weeks] of Object.entries(byOwner)) {
    filteredByOwner[owner] = {};
    originalCountsByOwner[owner] = {};
    for (const [weekStr, tasks] of Object.entries(weeks)) {
      const weekNum = Number(weekStr);
      const masters = tasks.filter(t => (t.taskType ?? "master") === "master");
      originalCountsByOwner[owner][weekNum] = masters.length;
      let visible = masters;
      if (showUnfinishedOnly) visible = masters.filter(t => t.status !== "completed");
      visible = [...visible].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
      filteredByOwner[owner][weekNum] = visible;
    }
  }

  const owners = [...ORDERED.filter(o => filteredByOwner[o]), ...Object.keys(filteredByOwner).filter(o => !ORDERED.includes(o))];
  if (owners.length === 0) return null;

  const dateLabel = "April 7 - 11";

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginLeft: 48, marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: "#666", fontFamily: F }}>{dateLabel}</div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.sub, fontFamily: F, cursor: "pointer", userSelect: "none" }}>
          <input
            type="checkbox"
            checked={showUnfinishedOnly}
            onChange={e => setShowUnfinishedOnly(e.target.checked)}
            style={{ cursor: "pointer", accentColor: "#F97316" }}
          />
          Show only unfinished tasks
        </label>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: 48 }} />
          <col /><col /><col /><col />
        </colgroup>
        <thead>
          <tr>
            <th style={{ padding: 0 }} />
            {APRIL_WEEKS.map(w => (
              <th key={w.n} style={{ textAlign: "center", fontSize: 13, fontWeight: 700, color: C.tx, fontFamily: F, padding: "6px 8px 10px" }}>
                Week {w.n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {owners.map(owner => {
            const weeks = filteredByOwner[owner] || {};
            const origWeeks = originalCountsByOwner[owner] || {};
            const pc = personColor(owner);
            // "All done" fires when: checkbox on, cell was not originally empty, but post-filter is empty
            const allDoneByWeek: Record<number, boolean> = {
              1: showUnfinishedOnly && (origWeeks[1] ?? 0) > 0 && (weeks[1]?.length ?? 0) === 0,
              2: showUnfinishedOnly && (origWeeks[2] ?? 0) > 0 && (weeks[2]?.length ?? 0) === 0,
              3: showUnfinishedOnly && (origWeeks[3] ?? 0) > 0 && (weeks[3]?.length ?? 0) === 0,
              4: showUnfinishedOnly && (origWeeks[4] ?? 0) > 0 && (weeks[4]?.length ?? 0) === 0,
            };
            const rows = Array.from({ length: ROWS_PER_PERSON }, (_, ri) => ({
              w1: (weeks[1] || [])[ri] || null,
              w2: (weeks[2] || [])[ri] || null,
              w3: (weeks[3] || [])[ri] || null,
              w4: (weeks[4] || [])[ri] || null,
            }));

            return rows.map((row, ri) => {
              const isFirstRow = ri === 0;
              const isLastRow = ri === ROWS_PER_PERSON - 1;
              return (
                <tr key={`${owner}-${ri}`}>
                  {isFirstRow && (
                    <td
                      rowSpan={ROWS_PER_PERSON}
                      style={{
                        verticalAlign: "middle", textAlign: "center",
                        padding: 0, borderBottom: "2px solid #ddd", width: 48,
                      }}
                    >
                      <div style={{
                        writingMode: "vertical-rl", transform: "rotate(180deg)",
                        fontSize: 13, fontWeight: 700, color: pc,
                        fontFamily: F, letterSpacing: 0.5, whiteSpace: "nowrap",
                      }}>
                        {owner}
                      </div>
                    </td>
                  )}
                  {[row.w1, row.w2, row.w3, row.w4].map((task, wi) => {
                    const weekNum = wi + 1;
                    // If this (owner, week) cell is "All done", render a single rowSpan'd td in ri=0 and skip the rest
                    if (allDoneByWeek[weekNum]) {
                      if (!isFirstRow) return null;
                      return (
                        <td
                          key={wi}
                          rowSpan={ROWS_PER_PERSON}
                          style={{
                            borderBottom: "2px solid #aaa",
                            borderLeft: "1px solid #e5e7eb",
                            borderRight: wi === 3 ? "1px solid #e5e7eb" : undefined,
                            padding: "8px 10px",
                            verticalAlign: "middle",
                            textAlign: "center",
                            background: "#F6FBF7",
                          }}
                        >
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, background: "#E8F5E9", border: `1px solid ${C.grn}40` }}>
                            <span style={{ fontSize: 13, color: C.grn, fontWeight: 700 }}>✓</span>
                            <span style={{ fontSize: 11, color: C.grn, fontWeight: 600, fontFamily: F, letterSpacing: 0.2 }}>All done</span>
                          </div>
                        </td>
                      );
                    }
                    const done = task?.status === "completed";
                    const cat = task?.category ?? "";
                    const sub = task?.subcategory ?? null;
                    const txColor = done ? "#bbb" : (CAT_COLOR[cat] ?? "#1565C0");
                    const stats = task ? childStats?.[task.id] : undefined;
                    const pct = stats && stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : null;
                    return (
                      <td
                        key={wi}
                        style={{
                          borderBottom: isLastRow ? "2px solid #aaa" : "1px solid #ddd",
                          borderLeft: `${task ? 3 : 1}px solid ${task ? (done ? "#ddd" : (CAT_COLOR[cat] ?? "#1565C0")) : "#e5e7eb"}`,
                          borderRight: wi === 3 ? "1px solid #e5e7eb" : undefined,
                          padding: "4px 7px",
                          verticalAlign: "top",
                          background: "#fff",
                          minHeight: 34,
                        }}
                      >
                        {task && (
                          <div style={{ display: "flex", gap: 5, alignItems: "flex-start" }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); onToggleTask(task.id, !done); }}
                              style={{
                                width: 12, height: 12, borderRadius: 2, marginTop: 2, flexShrink: 0,
                                border: `1.5px solid ${done ? C.grn : (CAT_COLOR[cat] ?? "#aaa")}`,
                                background: done ? C.grn : "transparent",
                                color: "#fff", fontSize: 7, cursor: "pointer",
                                display: "flex", alignItems: "center", justifyContent: "center",
                              }}
                            >{done ? "✓" : ""}</button>
                            <div
                              style={{ minWidth: 0, flex: 1, cursor: onTaskClick ? "pointer" : "default" }}
                              onClick={() => onTaskClick?.(task)}
                              title={onTaskClick ? "View this task and its sub-tasks" : undefined}
                            >
                              <div style={{
                                fontSize: 11, fontWeight: 600, color: txColor,
                                textDecoration: done ? "line-through" : "none",
                                fontFamily: F, lineHeight: 1.3,
                                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                display: "flex", alignItems: "center", gap: 4,
                              }}>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title.replace(/^[^:]+:\s*/, "")}</span>
                                {task.priority && <span style={{ fontSize: 8, fontWeight: 700, color: task.priority === "P0" ? C.red : task.priority === "P1" ? C.amb : C.grn, flexShrink: 0 }}>{task.priority}</span>}
                              </div>
                              {stats && stats.total > 0 && (
                                <div style={{
                                  marginTop: 2,
                                  display: "flex", alignItems: "center", gap: 5,
                                  fontSize: 9, fontFamily: F,
                                  color: done ? "#bbb" : (pct === 100 ? C.grn : C.mut),
                                }}>
                                  <span style={{ fontWeight: 600 }}>{stats.done}/{stats.total}</span>
                                  <div style={{ flex: 1, height: 3, background: "#eee", borderRadius: 2, overflow: "hidden", minWidth: 28, maxWidth: 60 }}>
                                    <div style={{ height: "100%", width: `${pct}%`, background: pct === 100 ? C.grn : pc, transition: "width 0.2s" }} />
                                  </div>
                                  <span style={{ fontWeight: 600 }}>{pct}%</span>
                                </div>
                              )}
                              {sub && (
                                <div style={{
                                  marginTop: 1,
                                  fontSize: 8, fontWeight: 600,
                                  color: done ? "#ccc" : (CAT_COLOR[cat] ?? "#555"),
                                  letterSpacing: 0.2,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }}>
                                  {sub}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Add Task Modal ───────────────────────────────────────────────────────────

function AddTaskModal({
  onClose, onCreated, categories, prefill, allTasks,
}: {
  onClose: () => void;
  onCreated: (task: PlanItem & { sprintId: string; position: number; total: number; prevTask?: { title: string; sprintId: string } | null; nextTask?: { title: string; sprintId: string } | null }) => void;
  categories: CategoryWithSubs[];
  prefill?: Record<string, string> | null;
  allTasks?: PlanItem[];
}) {
  const [form, setForm] = useState(() => {
    const defaults = { title: "", category: "", subcategoryName: "", owner: "", coOwner: "", priority: "P1", dueDate: "", atomicKpi: "", source: "manual", executionTier: "Sprint", workNotes: "", linearId: "", taskType: "master", parentTaskId: "" };
    if (prefill) return { ...defaults, ...Object.fromEntries(Object.entries(prefill).filter(([_, v]) => v != null && v !== "")) };
    return defaults;
  });
  const [subcats, setSubcats] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [manualOffset, setManualOffset] = useState(0); // user drags the new-task row in preview panel
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  // Linear ticket flow (only shown when source === "Linear")
  const [hasTicketId, setHasTicketId] = useState<"yes" | "no" | null>(null);
  // Single Slack notification toggle. When ON, the backend DMs the owner.
  // Message adapts: source=Linear + no ticket ID → "create the Linear ticket";
  // otherwise → "task assigned". Hidden when owner is unset or owner is Tony.
  const [notifyOwnerOnSlack, setNotifyOwnerOnSlack] = useState(true);

  // Reset the Linear sub-flow whenever the user changes Source away from / to Linear
  useEffect(() => {
    if (form.source !== "Linear") {
      setHasTicketId(null);
      setNotifyOwnerOnSlack(true);
      if (form.linearId) setForm(f => ({ ...f, linearId: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.source]);

  // Master tasks available for Sub-Task / Note parent selection
  const masterTasks = (allTasks || []).filter(t => t.taskType === "master" || !t.taskType);
  const selectedParent = form.parentTaskId ? masterTasks.find(m => m.id === form.parentTaskId) : null;
  const siblings = selectedParent ? (allTasks || []).filter(t => t.parentTaskId === selectedParent.id) : [];
  const masterSiblings = !selectedParent ? masterTasks : [];

  // Reset the user's nudge when the base position changes
  useEffect(() => { setManualOffset(0); }, [form.taskType, form.parentTaskId, form.priority]);

  useEffect(() => {
    if (!form.category) { setSubcats([]); return; }
    // Prefer passed categories, else fetch from API
    const cat = categories.find(c => c.category === form.category);
    if (cat) {
      setSubcats(cat.subcategories.map(s => s.title));
    } else {
      get(`/plan/subcategories/${form.category}`)
        .then((d: { subcategories: { title: string }[] }) => setSubcats((d.subcategories || []).map((s: { title: string }) => s.title)))
        .catch(() => setSubcats([]));
    }
    setForm(f => ({ ...f, subcategoryName: "" }));
  }, [form.category, categories]);

  function set(key: string, val: string) { setForm(f => ({ ...f, [key]: val })); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { setErr("Task title is required"); return; }
    if (!form.category) { setErr("Category is required"); return; }
    if ((form.taskType === "subtask" || form.taskType === "note") && !form.parentTaskId) {
      setErr(`${form.taskType === "note" ? "Note" : "Sub-Task"} requires a parent master task`);
      return;
    }
    // Linear source flow validation
    if (form.source === "Linear") {
      if (!hasTicketId) { setErr("Pick whether you already have the Linear ticket ID"); return; }
      if (hasTicketId === "yes" && !form.linearId.trim()) { setErr("Linear Issue ID is required"); return; }
    }
    setLoading(true); setErr("");
    try {
      // Single Slack-notify path — backend looks at source/linearId to pick the
      // right message body. Skip when owner is missing or is Tony himself.
      const ownerNeedsNotify =
        notifyOwnerOnSlack &&
        !!form.owner?.trim() &&
        form.owner.trim().toLowerCase() !== "tony";

      // Month derives from dueDate on backend; week has been removed entirely
      const payload: any = {
        ...form,
        // If source=Linear + ticket not yet created, ensure linearId is null
        linearId: form.source === "Linear" && hasTicketId === "yes" ? form.linearId : null,
        // Single flag — backend picks message body from source + linearId.
        // The legacy `requiresLinearTicket` is also set so existing backend
        // logic still fires the create-ticket message variant correctly.
        notifyOwnerSlack: ownerNeedsNotify,
        requiresLinearTicket: ownerNeedsNotify && form.source === "Linear" && hasTicketId === "no",
        parentTaskId: form.parentTaskId || undefined,
        // User may have nudged the placement ▲/▼ in the preview panel
        manualPosition: manualOffset !== 0 ? finalIdx : undefined,
      };
      const result:any = await post("/plan/task", payload);
      onCreated(result);
    } catch (e: any) {
      setErr(e.message || "Failed to create task");
    } finally {
      setLoading(false);
    }
  }

  const inputStyle: CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 7, border: `1px solid ${C.brd}`, fontFamily: F, fontSize: 13, background: "#fff", boxSizing: "border-box" };
  const labelStyle: CSSProperties = { fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5, fontFamily: F, marginBottom: 4, display: "block" };

  // Visualizer computes preview placement based on priority rank + any user nudge
  const { previewList, baseIdx, finalIdx } = (() => {
    const rank = (p: string | null | undefined) => ({ P0: 0, P1: 1, P2: 2 }[p || "P2"] ?? 2);
    const newItem = { id: "__new__", title: form.title || "(new task)", priority: form.priority, isNew: true } as any;
    const isNote = form.taskType === "note";
    const isMaster = form.taskType === "master";
    const sourceSiblings = isMaster ? masterSiblings : siblings;
    const items = [...sourceSiblings].sort((a, b) => (a.priorityOrder ?? 0) - (b.priorityOrder ?? 0));
    // Auto-placement by priority (or end-of-list for notes)
    let baseIdx: number;
    if (isNote) {
      baseIdx = items.length;
    } else {
      const found = items.findIndex(t => rank(t.priority) > rank(form.priority));
      baseIdx = found === -1 ? items.length : found;
    }
    // Apply user's ▲ ▼ nudge, clamped to valid range
    const finalIdx = Math.max(0, Math.min(items.length, baseIdx + manualOffset));
    items.splice(finalIdx, 0, newItem);
    return { previewList: items, baseIdx, finalIdx };
  })();
  void baseIdx; // used inside the drag-drop handler below

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: C.bg, borderRadius: "16px 16px 0 0", width: "100%", maxWidth: 980, maxHeight: "92vh", boxShadow: "0 -8px 40px rgba(0,0,0,0.2)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 28px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: C.tx, fontFamily: F }}>Add task to 411 Plan</div>
            <div style={{ fontSize: 12, color: C.sub, fontFamily: F, marginTop: 2 }}>Fill in the details and the task will be placed by priority</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.mut, fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ display: "flex", flex: 1, overflow: "hidden", gap: 0 }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 28px 28px" }}>
        <form onSubmit={submit}>
          {/* Title */}
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Task title *</label>
            <input value={form.title} onChange={e => set("title", e.target.value)} placeholder="e.g. Tony: close 2 new operators" style={inputStyle} />
          </div>

          {/* Type + Parent */}
          <div style={{ display: "grid", gridTemplateColumns: form.taskType === "master" ? "1fr" : "1fr 1.4fr", gap: 14, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Task type *</label>
              <select
                value={form.taskType}
                onChange={e => {
                  const nextType = e.target.value;
                  setForm(f => ({ ...f, taskType: nextType, parentTaskId: nextType === "master" ? "" : f.parentTaskId }));
                }}
                style={inputStyle}
              >
                <option value="master">📌 Master Task — top-level</option>
                <option value="subtask">↳ Sub-Task — child of a master</option>
                <option value="note">📝 Note — info attached to master</option>
              </select>
            </div>
            {form.taskType !== "master" && (
              <div>
                <label style={labelStyle}>Parent master task *</label>
                <select value={form.parentTaskId} onChange={e => set("parentTaskId", e.target.value)} style={inputStyle}>
                  <option value="">Select parent master…</option>
                  {masterTasks.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
                </select>
              </div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            {/* Category */}
            <div>
              <label style={labelStyle}>Category *</label>
              <select value={form.category} onChange={e => set("category", e.target.value)} style={inputStyle}>
                <option value="">Select category</option>
                {CAT_KEYS.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
              </select>
            </div>
            {/* Subcategory */}
            <div>
              <label style={labelStyle}>Subcategory</label>
              <select value={form.subcategoryName} onChange={e => set("subcategoryName", e.target.value)} style={inputStyle} disabled={!form.category}>
                <option value="">Select subcategory</option>
                {subcats.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            {/* Owner */}
            <div>
              <label style={labelStyle}>Owner</label>
              <select value={form.owner} onChange={e => set("owner", e.target.value)} style={inputStyle}>
                <option value="">Unassigned</option>
                {OWNER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            {/* Co-Owner */}
            <div>
              <label style={labelStyle}>Co-Owner</label>
              <select value={form.coOwner} onChange={e => set("coOwner", e.target.value)} style={inputStyle}>
                <option value="">— None —</option>
                {OWNER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            {/* Priority */}
            <div>
              <label style={labelStyle}>Priority — determines placement</label>
              <select value={form.priority} onChange={e => set("priority", e.target.value)} style={inputStyle}>
                {PRIORITY_OPTS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            {/* Due date — week is auto-derived from this on the weekly grid */}
            <div>
              <label style={labelStyle}>Due date <span style={{ fontWeight: 400, color: C.mut, textTransform: "none", letterSpacing: 0 }}>— week is auto-computed</span></label>
              <input type="date" value={form.dueDate} onChange={e => set("dueDate", e.target.value)} style={inputStyle} />
            </div>
            {/* Execution tier */}
            <div>
              <label style={labelStyle}>Execution tier</label>
              <select value={form.executionTier} onChange={e => set("executionTier", e.target.value)} style={inputStyle}>
                {TIER_OPTS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* Atomic KPI */}
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Atomic KPI — how does this move an AA toward 2 deals/month?</label>
            <input value={form.atomicKpi} onChange={e => set("atomicKpi", e.target.value)} placeholder="e.g. Signed operator = 4 new AAs in pipeline" style={inputStyle} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <div>
              <label style={labelStyle}>Source</label>
              <select value={form.source} onChange={e => set("source", e.target.value)} style={inputStyle}>
                {SOURCE_OPTS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Work notes</label>
              <input value={form.workNotes} onChange={e => set("workNotes", e.target.value)} placeholder="Context, blockers, links…" style={inputStyle} />
            </div>
          </div>

          {form.source === "Linear" && (
            <div style={{ marginBottom: 18, padding: "12px 14px", border: `1px solid ${C.brd}`, borderRadius: 8, background: "#FAFAFA" }}>
              <label style={labelStyle}>Do you already have the Linear ticket ID?</label>
              <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: C.tx }}>
                  <input
                    type="radio"
                    name="hasTicketId"
                    checked={hasTicketId === "yes"}
                    onChange={() => setHasTicketId("yes")}
                    style={{ accentColor: "#F97316" }}
                  />
                  Yes, I have it
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: C.tx }}>
                  <input
                    type="radio"
                    name="hasTicketId"
                    checked={hasTicketId === "no"}
                    onChange={() => setHasTicketId("no")}
                    style={{ accentColor: "#F97316" }}
                  />
                  No, assign owner to create it
                </label>
              </div>

              {hasTicketId === "yes" && (
                <div style={{ marginTop: 12 }}>
                  <label style={labelStyle}>Linear Issue ID *</label>
                  <input
                    value={form.linearId}
                    onChange={e => set("linearId", e.target.value)}
                    placeholder="e.g. FLI-123  or  FLI-123, FLI-456 for multiple"
                    style={inputStyle}
                  />
                  <div style={{ fontSize: 10, color: C.mut, marginTop: 3 }}>Links this task to Linear — completion will sync both ways. Separate multiple IDs with commas for one task spanning multiple tickets.</div>
                </div>
              )}

            </div>
          )}

          {form.source !== "Linear" && <div style={{ marginBottom: 6 }} />}

          {/* Single Slack-notify checkbox — visible whenever the owner is set
              and is NOT Tony. Label/description adapts: when source=Linear and
              no ticket ID is provided, the DM asks the owner to create the
              Linear ticket; otherwise it's a generic task-assigned notice. */}
          {form.owner && form.owner.trim() && form.owner.trim().toLowerCase() !== "tony" && (() => {
            const isLinearCreate = form.source === "Linear" && hasTicketId === "no";
            return (
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", border: `1px solid ${C.brd}`, borderRadius: 8, background: "#F9FAFB", marginBottom: 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={notifyOwnerOnSlack}
                  onChange={e => setNotifyOwnerOnSlack(e.target.checked)}
                  style={{ marginTop: 2, accentColor: "#F97316", cursor: "pointer" }}
                />
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: C.tx, fontFamily: F }}>
                    💬 Notify <strong>{form.owner}</strong> on Slack
                  </span>
                  <span style={{ display: "block", fontSize: 11, color: C.mut, marginTop: 2, fontFamily: F, lineHeight: 1.4 }}>
                    {isLinearCreate
                      ? `Sends a DM with the task details and asks ${form.owner} to create the matching Linear ticket. Once they paste the Linear ID back here, both systems stay in sync.`
                      : `Sends a DM with the task details so ${form.owner} sees it in Slack right away.`}
                  </span>
                </span>
              </label>
            );
          })()}

          {err && <div style={{ background: C.redBg, color: C.red, borderRadius: 7, padding: "8px 12px", fontSize: 12, marginBottom: 14, fontFamily: F }}>{err}</div>}

          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={onClose} style={{ flex: 1, padding: "10px", borderRadius: 8, border: `1px solid ${C.brd}`, background: "transparent", color: C.sub, fontSize: 13, cursor: "pointer", fontFamily: F }}>Cancel</button>
            <button type="submit" disabled={loading} style={{ flex: 2, padding: "10px", borderRadius: 8, border: "none", background: "#F97316", color: "#fff", fontSize: 13, fontWeight: 700, cursor: loading ? "default" : "pointer", fontFamily: F }}>
              {loading ? "Adding…" : "Add task & place in 411 plan"}
            </button>
          </div>
        </form>
          </div>
          {/* ── Sidebar visualizer ── */}
          <div style={{ width: 280, flexShrink: 0, borderLeft: `1px solid ${C.brd}`, background: "#F9FAFB", overflowY: "auto", padding: "16px 18px 28px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 0.5 }}>Preview placement</div>
              {manualOffset !== 0 && (
                <button
                  type="button"
                  onClick={() => setManualOffset(0)}
                  title="Reset to auto placement"
                  style={{ fontSize: 9, background: "none", border: `1px solid ${C.brd}`, borderRadius: 4, padding: "2px 6px", color: C.sub, cursor: "pointer", fontFamily: F }}
                >↺ reset auto</button>
              )}
            </div>
            <div style={{ fontSize: 10, color: C.mut, marginBottom: 6 }}>
              {form.taskType === "master" && "Among master tasks, sorted by priority"}
              {form.taskType === "subtask" && selectedParent && `Under "${selectedParent.title}", by priority`}
              {form.taskType === "subtask" && !selectedParent && "Pick a parent master task first"}
              {form.taskType === "note" && selectedParent && `Attached to "${selectedParent.title}"`}
              {form.taskType === "note" && !selectedParent && "Pick a parent master task first"}
            </div>
            {(form.taskType === "master" || selectedParent) && (
              <div style={{ fontSize: 9, color: C.mut, fontStyle: "italic", marginBottom: 10 }}>
                ⠿ Drag the highlighted row to change its placement
              </div>
            )}
            {manualOffset !== 0 && (
              <div style={{ fontSize: 10, color: "#F97316", marginBottom: 10, fontWeight: 600 }}>
                ⚠ Manually placed at #{finalIdx + 1} (auto would put it at #{finalIdx - manualOffset + 1})
              </div>
            )}
            {(form.taskType === "master" || selectedParent) && (() => {
              // Window 6 items before + new item + 6 after, so the highlighted row is always visible.
              const newIdx = previewList.findIndex((t: any) => t.id === "__new__");
              const WINDOW = 6;
              const start = Math.max(0, newIdx - WINDOW);
              const end = Math.min(previewList.length, newIdx + WINDOW + 1);
              const visible = previewList.slice(start, end);
              const hiddenBefore = start;
              const hiddenAfter = previewList.length - end;
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {hiddenBefore > 0 && <div style={{ fontSize: 10, color: C.mut, fontStyle: "italic", textAlign: "center", padding: "4px 0" }}>↑ {hiddenBefore} earlier task{hiddenBefore === 1 ? "" : "s"}</div>}
                  {visible.map((t: any, i: number) => {
                    const isNew = t.id === "__new__";
                    const absIdx = start + i;
                    return (
                      <div
                        key={t.id + "-" + absIdx}
                        draggable={isNew}
                        onDragStart={isNew ? (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "__new__"); } : undefined}
                        onDragOver={!isNew ? (e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          // Determine if dropping on top-half or bottom-half of this row
                          const rect = e.currentTarget.getBoundingClientRect();
                          const dropAfter = (e.clientY - rect.top) > rect.height / 2;
                          setDragOverIdx(dropAfter ? absIdx + 1 : absIdx);
                        } : undefined}
                        onDragLeave={!isNew ? () => setDragOverIdx(null) : undefined}
                        onDrop={!isNew ? (e) => {
                          e.preventDefault();
                          if (dragOverIdx === null) return;
                          // Compute target index in the sibling list (i.e. WITHOUT the new item).
                          // previewList indices include the new item; removing it shifts everything after finalIdx by -1.
                          // dragOverIdx is an index in previewList (which includes the new item).
                          // Convert to sibling-list index:
                          let targetIdx = dragOverIdx;
                          if (dragOverIdx > finalIdx) targetIdx = dragOverIdx - 1; // remove new item's slot
                          setManualOffset(targetIdx - baseIdx);
                          setDragOverIdx(null);
                        } : undefined}
                        style={{
                          padding: isNew ? "10px 12px" : "7px 10px",
                          borderRadius: 6,
                          border: `${isNew ? 2 : 1}px solid ${isNew ? "#F97316" : C.brd}`,
                          background: isNew ? "#FFF7ED" : "#fff",
                          fontSize: 11,
                          fontFamily: F,
                          color: isNew ? "#C2410C" : C.tx,
                          fontWeight: isNew ? 700 : 400,
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          boxShadow: isNew ? "0 2px 8px rgba(249,115,22,0.25)" : "none",
                          cursor: isNew ? "grab" : "default",
                          borderTop: dragOverIdx === absIdx && !isNew ? `2px solid #F97316` : undefined,
                          borderBottom: dragOverIdx === absIdx + 1 && !isNew ? `2px solid #F97316` : undefined,
                        }}
                      >
                        {isNew && <span style={{ fontSize: 10, color: "#F97316", opacity: 0.6, cursor: "grab" }}>⠿</span>}
                        <span style={{ fontSize: 9, color: isNew ? "#F97316" : C.mut, minWidth: 26, fontWeight: isNew ? 700 : 400 }}>#{absIdx + 1}</span>
                        {form.taskType !== "master" && <span style={{ color: C.mut }}>↳</span>}
                        {isNew && <span style={{ fontSize: 10 }}>⭐</span>}
                        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{isNew ? (t.title || "(new task)") : t.title}</span>
                        {t.priority && form.taskType !== "note" && <span style={{ fontSize: 9, fontWeight: 700, color: t.priority === "P0" ? C.red : t.priority === "P1" ? C.amb : C.grn }}>{t.priority}</span>}
                      </div>
                    );
                  })}
                  {hiddenAfter > 0 && <div style={{ fontSize: 10, color: C.mut, fontStyle: "italic", textAlign: "center", padding: "4px 0" }}>↓ {hiddenAfter} later task{hiddenAfter === 1 ? "" : "s"}</div>}
                  {previewList.length === 0 && <div style={{ fontSize: 11, color: C.mut, fontStyle: "italic" }}>No siblings — this will be the first.</div>}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Task Detail Modal ───────────────────────────────────────────────────────

function TaskDetailModal({ task, onClose, onSaved }: {
  task: PlanItem & { sprintId?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    workNotes: task.workNotes || "",
    atomicKpi: task.atomicKpi || "",
    dueDate: task.dueDate || "",
    owner: task.owner || "",
    priority: task.priority || "",
    title: task.title || "",
    category: task.category || "",
    subcategory: task.subcategory || "",
    executionTier: task.executionTier || "Sprint",
    source: task.source || "manual",
    linearId: task.linearId || "",
    coOwner: task.coOwner || "",
    // Highlight feature: optional color + note. Cleared together via the picker.
    highlightColor: task.highlightColor || "",
    highlightNote: task.highlightNote || "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [subcats, setSubcats] = useState<string[]>([]);

  const [validationErr, setValidationErr] = useState("");

  // Fetch subcategories when category changes — reset subcategory on category change
  const prevCat = useRef(form.category);
  useEffect(() => {
    if (!form.category) { setSubcats([]); return; }
    get<{ subcategories: { title: string }[] }>(`/plan/subcategories/${form.category}`)
      .then(d => setSubcats((d.subcategories || []).map(s => s.title)))
      .catch(() => setSubcats([]));
    if (prevCat.current && prevCat.current !== form.category) {
      setForm(p => ({ ...p, subcategory: "" }));
    }
    prevCat.current = form.category;
  }, [form.category]);

  const catColor = CAT_COLOR[task.category] ?? "#555";

  async function handleSave() {
    // Validate required fields
    if (!form.title.trim()) { setValidationErr("Task title is required"); return; }
    if (!form.category) { setValidationErr("Category is required"); return; }
    if (!form.owner) { setValidationErr("Owner is required"); return; }
    if (!form.priority) { setValidationErr("Priority is required"); return; }
    // Highlight rule (Tony's 2026-05-16 PDF): highlighted tasks must have a due date.
    if (form.highlightColor && !form.dueDate) {
      setValidationErr("Highlighted tasks must have a due date.");
      return;
    }
    setValidationErr("");
    setSaving(true);
    try {
      // Convert empty strings to nulls for the highlight columns so a cleared
      // highlight wipes the row (BE PATCH handler triggers the highlightAt /
      // highlightNote reset when highlightColor is falsy).
      const payload = {
        ...form,
        highlightColor: form.highlightColor || null,
        highlightNote: form.highlightColor ? (form.highlightNote || null) : null,
      };
      await patch(`/plan/item/${task.id}`, payload);
      setSaved(true);
      setTimeout(() => { onSaved(); onClose(); }, 600);
    } catch (err) {
      // Surface BE-side validation errors (e.g. highlight w/o due date).
      const msg = err instanceof Error ? err.message : "Save failed";
      setValidationErr(msg.slice(0, 200));
    }
    finally { setSaving(false); }
  }

  const inp: CSSProperties = {
    width: "100%", padding: "8px 10px", borderRadius: 7, border: `1px solid ${C.brd}`,
    fontFamily: F, fontSize: 13, background: "#fafafa", boxSizing: "border-box",
  };
  const lbl: CSSProperties = { fontSize: 10, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9000, display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      {/* Backdrop */}
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)" }} onClick={onClose} />

      {/* Slide-in panel */}
      <div style={{
        position: "relative", zIndex: 1, width: 480, height: "100vh",
        background: "#fff", boxShadow: "-8px 0 32px rgba(0,0,0,0.15)",
        display: "flex", flexDirection: "column", overflowY: "auto",
      }}>
        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: `2px solid ${C.brd}`, background: "#FAFAFA" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {task.sprintId && <span style={{ fontSize: 11, fontWeight: 800, color: catColor, background: catColor + "15", borderRadius: 5, padding: "2px 8px", fontFamily: "monospace" }}>{task.sprintId}</span>}
              {task.priority && <PriorityBadge p={task.priority} />}
              {task.status && <StatusPill s={task.status} />}
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: C.mut, lineHeight: 1 }}>✕</button>
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.tx, lineHeight: 1.4, marginBottom: 6 }}>{task.title}</div>
          <div style={{ fontSize: 11, color: C.sub }}>
            <span style={{ fontWeight: 600, color: catColor, textTransform: "capitalize" }}>{task.category}</span>
            {task.subcategory && <span> · {task.subcategory}</span>}
            {task.owner && <span> · <span style={{ fontWeight: 600 }}>{task.owner}</span></span>}
          </div>
          {task.completedAt && (
            <div style={{ marginTop: 6, fontSize: 11, color: C.grn, fontWeight: 600 }}>
              ✓ Completed {new Date(task.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </div>
          )}
        </div>

        {/* Editable fields */}
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>

          <div>
            <label style={lbl}>Task title</label>
            <input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} style={inp} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={lbl}>Owner</label>
              <select value={form.owner} onChange={e => setForm(p => ({ ...p, owner: e.target.value }))} style={inp}>
                <option value="">—</option>
                {OWNER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Co-Owner</label>
              <select value={form.coOwner} onChange={e => setForm(p => ({ ...p, coOwner: e.target.value }))} style={inp}>
                <option value="">— None —</option>
                {OWNER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={lbl}>Priority</label>
              <select value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))} style={inp}>
                <option value="">—</option>
                <option value="P0">P0 — Critical</option>
                <option value="P1">P1 — High</option>
                <option value="P2">P2 — Standard</option>
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={lbl}>Category</label>
              <select value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))} style={inp}>
                <option value="">—</option>
                {CAT_KEYS.map(k => <option key={k} value={k}>{CAT_LABELS[k] || k}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Subcategory</label>
              <select value={form.subcategory} onChange={e => setForm(p => ({ ...p, subcategory: e.target.value }))} style={inp}>
                <option value="">— Select —</option>
                {subcats.map(s => <option key={s} value={s}>{s}</option>)}
                {form.subcategory && !subcats.includes(form.subcategory) && (
                  <option value={form.subcategory}>{form.subcategory}</option>
                )}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={lbl}>Execution Tier</label>
              <select value={form.executionTier} onChange={e => setForm(p => ({ ...p, executionTier: e.target.value }))} style={inp}>
                <option value="Sprint">Sprint</option>
                <option value="Strategic">Strategic</option>
                <option value="Maintenance">Maintenance</option>
              </select>
            </div>
            <div>
              <label style={lbl}>Source</label>
              <select value={form.source} onChange={e => setForm(p => ({ ...p, source: e.target.value }))} style={inp}>
                <option value="manual">Manual</option>
                <option value="OAP">OAP</option>
                <option value="Linear">Linear</option>
                <option value="TCC">TCC</option>
              </select>
            </div>
          </div>

          <div>
            <label style={lbl}>Due date</label>
            <input type="date" value={form.dueDate} onChange={e => setForm(p => ({ ...p, dueDate: e.target.value }))} style={inp} />
          </div>

          {/* C7 (Tony's 2026-05-16): Linear tie-ins available on ANY task, not
              just source=Linear. Typeahead picker replaces the manual comma list. */}
          <LinearAttachPicker
            value={form.linearId}
            onChange={next => setForm(p => ({ ...p, linearId: next }))}
            label="Linear issues (attach / remove)"
          />
          {form.source === "Linear" && form.linearId === "" && (
            <div style={{ fontSize: 10, color: C.amb, marginTop: -4 }}>
              Source is "Linear" but no issues attached yet.
            </div>
          )}

          {/* Highlight feature (Tony's 2026-05-16 screenshare + PDF). */}
          <HighlightPicker
            color={form.highlightColor || null}
            note={form.highlightNote || null}
            hasDueDate={!!form.dueDate}
            onChange={next => setForm(p => ({
              ...p,
              highlightColor: next.color ?? "",
              highlightNote: next.note ?? "",
            }))}
          />

          <div>
            <label style={lbl}>Atomic KPI</label>
            <input value={form.atomicKpi} onChange={e => setForm(p => ({ ...p, atomicKpi: e.target.value }))} placeholder="What does done look like?" style={inp} />
          </div>

          <div>
            <label style={lbl}>Work notes / context</label>
            <textarea
              value={form.workNotes}
              onChange={e => setForm(p => ({ ...p, workNotes: e.target.value }))}
              placeholder="Blockers, links, context, decisions…"
              rows={6}
              style={{ ...inp, resize: "vertical", lineHeight: 1.5 }}
            />
          </div>

          {/* C7: the LinearAttachPicker above already renders attached IDs as
              chips with title + open-in-Linear link + remove button; the old
              duplicate "Linear Links" badge row is removed. */}
        </div>

        {/* Footer */}
        <div style={{ padding: "16px 24px", borderTop: `1px solid ${C.brd}`, display: "flex", flexDirection: "column", gap: 10 }}>
          {validationErr && (
            <div style={{ padding: "8px 12px", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 6, fontSize: 12, color: "#991B1B", fontWeight: 600 }}>
              {validationErr}
            </div>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onClose} style={{ flex: 1, padding: "10px", borderRadius: 8, border: `1px solid ${C.brd}`, background: "transparent", color: C.sub, fontSize: 13, cursor: "pointer", fontFamily: F }}>Cancel</button>
            <button onClick={handleSave} disabled={saving || saved} style={{
              flex: 2, padding: "10px", borderRadius: 8, border: "none",
              background: saved ? C.grn : "#F97316", color: "#fff",
              fontSize: 13, fontWeight: 700, cursor: saving ? "wait" : "pointer", fontFamily: F,
            }}>
              {saved ? "✓ Saved" : saving ? "Saving…" : "Save changes"}
            </button>
          </div>
          {confirmDelete ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: "#FEF2F2", borderRadius: 8, border: "1px solid #FECACA" }}>
              <span style={{ fontSize: 12, color: "#991B1B", flex: 1 }}>Delete this task permanently?</span>
              <button onClick={async () => {
                setDeleting(true);
                try { await del(`/plan/task/${task.id}`); onSaved(); onClose(); } catch { /**/ }
                finally { setDeleting(false); }
              }} disabled={deleting} style={{ padding: "5px 14px", borderRadius: 6, border: "none", background: "#DC2626", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: F }}>
                {deleting ? "Deleting…" : "Delete"}
              </button>
              <button onClick={() => setConfirmDelete(false)} style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.brd}`, background: "#fff", color: C.sub, fontSize: 12, cursor: "pointer", fontFamily: F }}>No</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} style={{ padding: "8px", borderRadius: 8, border: `1px solid #FECACA`, background: "transparent", color: "#DC2626", fontSize: 11, cursor: "pointer", fontFamily: F, fontWeight: 600 }}>
              Delete task
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sprint ID recalculator (client-side, mirrors server logic) ──────────────

const CAT_PREFIX_CLIENT: Record<string, string> = {
  adaptation: "ADP", sales: "SLS", tech: "TCH", capital: "CAP", team: "TME",
};

// Build a CSV string from header + rows, with proper quoting + UTF-8 BOM for Excel.
function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(esc).join(","), ...rows.map(r => r.map(esc).join(","))];
  return "\uFEFF" + lines.join("\r\n");
}

function downloadBlob(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Split a Linear ID field value into individual ticket IDs (comma-separated supported).
// Trims whitespace, drops empties, dedupes while preserving order.
function splitLinearIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  return raw.split(",").map(s => s.trim()).filter(s => {
    if (!s) return false;
    const lower = s.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

function recalcSprintIds(taskList: (PlanItem & { sprintId?: string })[]): (PlanItem & { sprintId: string })[] {
  const catCounter: Record<string, number> = {};
  return taskList.map(t => {
    const cat = t.category || "misc";
    if (!catCounter[cat]) catCounter[cat] = 0;
    catCounter[cat]++;
    const prefix = CAT_PREFIX_CLIENT[cat] || cat.slice(0, 3).toUpperCase();
    return { ...t, sprintId: `${prefix}-${String(catCounter[cat]).padStart(2, "0")}` };
  });
}

// ─── Master Task Table ────────────────────────────────────────────────────────

type PendingDrop = {
  movedTask: PlanItem & { sprintId?: string };
  displacedTasks: (PlanItem & { sprintId?: string })[];
  fromIdx: number;
  toIdx: number;
  newTasks: (PlanItem & { sprintId?: string })[];
  prevTasks: (PlanItem & { sprintId?: string })[];
};

type OrganizePreview = {
  newOrder: (PlanItem & { sprintId?: string })[];
  currentOrder: (PlanItem & { sprintId?: string })[];
};

function MasterTaskTab({ onRefreshAll, categories, initialParentFilter, onInitialParentFilterConsumed, initialPrefill, onInitialPrefillConsumed, initialCategoryFilter, onInitialCategoryFilterConsumed }: {
  onRefreshAll: () => void;
  categories: CategoryWithSubs[];
  initialParentFilter?: string | null;
  onInitialParentFilterConsumed?: () => void;
  initialPrefill?: Record<string, string> | null;
  onInitialPrefillConsumed?: () => void;
  /** E1: filter master task list by this category on mount (jump-to from 411 cascade). */
  initialCategoryFilter?: string | null;
  onInitialCategoryFilterConsumed?: () => void;
}) {
  const [tasks, setTasks] = useState<(PlanItem & { sprintId?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCat, setFilterCat] = useState(initialCategoryFilter || "");
  const [filterOwner, setFilterOwner] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  const [filterWeek, setFilterWeek] = useState("");
  const [filterParent, setFilterParent] = useState(initialParentFilter || "");
  const [filterLinearOnly, setFilterLinearOnly] = useState(false);
  // Highlight filter: '' = no filter, 'any' = any highlight, '<color>' = that specific color.
  const [filterHighlight, setFilterHighlight] = useState<string>("");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  // E1: apply incoming category filter when prop changes (e.g. user clicked
  // another category in the 411 cascade while master tab already mounted).
  useEffect(() => {
    if (initialCategoryFilter) {
      setFilterCat(initialCategoryFilter);
      onInitialCategoryFilterConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCategoryFilter]);
  const [searchQ, setSearchQ] = useState("");

  // When parent filter comes from outside (weekly grid click), adopt it and notify caller
  useEffect(() => {
    if (initialParentFilter) {
      setFilterParent(initialParentFilter);
      onInitialParentFilterConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialParentFilter]);
  const [sortCol, setSortCol] = useState<string>("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showAdd, setShowAdd] = useState(false);
  const [prefillData, setPrefillData] = useState<Record<string, string> | null>(null);
  const [placementToast, setPlacementToast] = useState<string | null>(null);

  // Listen for idea-to-task prefill events (legacy global event path —
  // still useful when the prefill request comes from outside BusinessView)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) { setPrefillData(detail); setShowAdd(true); }
    };
    window.addEventListener("tcc:prefill-task", handler);
    return () => window.removeEventListener("tcc:prefill-task", handler);
  }, []);

  // Prop-driven prefill — used when Convert to Task happens inside the same
  // BusinessView (e.g. from the Ideas tab). The prop survives the tab switch
  // and fires immediately on mount, no event-listener race.
  useEffect(() => {
    if (initialPrefill) {
      setPrefillData(initialPrefill);
      setShowAdd(true);
      onInitialPrefillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrefill]);
  const [editId, setEditId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragTaskRef = useRef<string | null>(null);
  const justDroppedRef = useRef<number>(0); // timestamp of last drop; used to suppress click-open of detail panel
  // When a task is just created, scroll its row into view and pulse-highlight it briefly
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const [selectedTask, setSelectedTask] = useState<(PlanItem & { sprintId?: string }) | null>(null);
  type HoverInfo = { task: PlanItem & { sprintId?: string }; x: number; y: number };
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Training modal state
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  const [trainingExplanation, setTrainingExplanation] = useState("");
  const [submittingTraining, setSubmittingTraining] = useState(false);
  const [aiReflection, setAiReflection] = useState<string | null>(null);

  // AI Organize state
  const [organizing, setOrganizing] = useState(false);
  const [organizePreview, setOrganizePreview] = useState<OrganizePreview | null>(null);
  const [confirmingOrganize, setConfirmingOrganize] = useState(false);

  const loadTasks = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await get("/plan/tasks");
      setTasks((data as any).tasks || []);
    } catch { /**/ }
    finally { if (!silent) setLoading(false); }
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  // All filtering is client-side so cards always have full per-category data
  let displayed = tasks;
  if (filterCat) displayed = displayed.filter(t => t.category === filterCat);
  if (filterOwner) displayed = displayed.filter(t => t.owner === filterOwner);
  if (filterStatus) displayed = displayed.filter(t => t.status === filterStatus);
  if (filterPriority) displayed = displayed.filter(t => t.priority === filterPriority);
  if (filterWeek) {
    // Week is derived from dueDate day-of-month: ≤11=1, ≤18=2, ≤25=3, else 4.
    const weekOf = (d?: string | null) => {
      if (!d) return null;
      const day = parseInt(d.slice(8, 10), 10);
      if (isNaN(day)) return null;
      if (day <= 11) return 1;
      if (day <= 18) return 2;
      if (day <= 25) return 3;
      return 4;
    };
    displayed = displayed.filter(t => String(weekOf(t.dueDate)) === filterWeek);
  }
  if (filterParent) {
    // Show the selected master + all its children (subs and notes)
    displayed = displayed.filter(t => t.id === filterParent || t.parentTaskId === filterParent);
  }
  if (filterLinearOnly) {
    // Linear-only: source is "Linear" OR row has a linearId (covers edge cases where source wasn't set explicitly)
    displayed = displayed.filter(t => t.source === "Linear" || !!t.linearId);
  }
  if (filterHighlight) {
    // Highlight filter: 'any' = any highlight set, otherwise match specific color value
    displayed = filterHighlight === "any"
      ? displayed.filter(t => !!t.highlightColor)
      : displayed.filter(t => t.highlightColor === filterHighlight);
  }
  if (searchQ.trim()) {
    const q = searchQ.trim().toLowerCase();
    displayed = displayed.filter(t =>
      (t.title || "").toLowerCase().includes(q) ||
      (t.owner || "").toLowerCase().includes(q) ||
      (t.coOwner || "").toLowerCase().includes(q) ||
      (t.category || "").toLowerCase().includes(q) ||
      (t.subcategory || "").toLowerCase().includes(q) ||
      (t.atomicKpi || "").toLowerCase().includes(q) ||
      (t.workNotes || "").toLowerCase().includes(q) ||
      (t.source || "").toLowerCase().includes(q) ||
      (t.linearId || "").toLowerCase().includes(q)
    );
  }

  // ── Hierarchical flatten with sort applied WITHIN each tier ──
  // Masters sort among masters. Subs sort within their parent's children. Notes always land last within a parent.
  // When no sort column is active, both tiers fall back to priorityOrder.
  {
    const SORT_KEYS: Record<string, (t: PlanItem & { sprintId?: string }) => string> = {
      "Sprint ID": t => t.sprintId || "",
      "Tier": t => t.executionTier || "",
      "Category": t => t.category || "",
      "Sub-Category": t => t.subcategory || "",
      "Task": t => t.title || "",
      "Atomic KPI": t => t.atomicKpi || "",
      "Owner": t => t.owner || "",
      "Co-Owner": t => t.coOwner || "",
      "Source": t => t.source || "",
      "Priority": t => t.priority || "",
      "Status": t => t.status || "",
      "Due Date": t => t.dueDate || "",
      "Completed": t => t.completedAt || "",
      "Notes": t => t.workNotes || "",
      "Linear": t => t.linearId || "",
    };
    const keyFn = sortCol ? SORT_KEYS[sortCol] : null;
    const cmp = (a: PlanItem & { sprintId?: string }, b: PlanItem & { sprintId?: string }) => {
      if (keyFn) {
        const av = keyFn(a).toLowerCase(), bv = keyFn(b).toLowerCase();
        const r = sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        if (r !== 0) return r;
      }
      return (a.priorityOrder ?? 0) - (b.priorityOrder ?? 0);
    };

    const displayedIds = new Set(displayed.map(t => t.id));
    const masters = displayed
      .filter(t => (t.taskType ?? "master") === "master")
      .sort(cmp);

    const childrenOf = (mid: string) => {
      const kids = displayed.filter(t => t.parentTaskId === mid && (t.taskType === "subtask" || t.taskType === "note"));
      const subs = kids.filter(t => t.taskType === "subtask").sort(cmp);
      const notes = kids.filter(t => t.taskType === "note").sort(cmp);
      return [...subs, ...notes];
    };

    const tree: (PlanItem & { sprintId?: string })[] = [];
    for (const m of masters) {
      tree.push(m);
      // If this master is collapsed, skip its children
      if (!collapsedIds.has(m.id)) {
        for (const c of childrenOf(m.id)) tree.push(c);
      }
    }

    // Orphans: subs/notes whose parent was filtered out of `displayed`
    const orphans = displayed
      .filter(t => (t.taskType === "subtask" || t.taskType === "note") && t.parentTaskId && !masters.some(m => m.id === t.parentTaskId))
      .sort(cmp);
    for (const o of orphans) tree.push(o);

    displayed = tree.filter(t => displayedIds.has(t.id));
  }

  // Child count per master (used to decide whether the chevron shows)
  const childCountByMaster = (() => {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      if (t.parentTaskId && (t.taskType === "subtask" || t.taskType === "note")) {
        counts.set(t.parentTaskId, (counts.get(t.parentTaskId) ?? 0) + 1);
      }
    }
    return counts;
  })();

  const toggleCollapse = (masterId: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(masterId)) next.delete(masterId); else next.add(masterId);
      return next;
    });
  };

  const allMasters = tasks.filter(t => (t.taskType ?? "master") === "master").sort((a, b) => (a.sprintId || "").localeCompare(b.sprintId || "", undefined, { numeric: true }));
  const anyCollapsed = collapsedIds.size > 0;
  const anyExpandable = Array.from(childCountByMaster.values()).some(c => c > 0);

  // ── Delete-confirmation dialog state (for Master with children) ──
  const [deleteDialog, setDeleteDialog] = useState<{
    taskId: string;
    taskTitle: string;
    subCount: number;
    noteCount: number;
  } | null>(null);

  async function handleDeleteTask(id: string) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    // For Master tasks, check for children and show dialog
    if ((task.taskType ?? "master") === "master") {
      try {
        const children = await get<{ total: number; subCount: number; noteCount: number }>(`/plan/task/${id}/children`);
        if (children.total > 0) {
          setDeleteDialog({ taskId: id, taskTitle: task.title, subCount: children.subCount, noteCount: children.noteCount });
          return;
        }
      } catch { /* fallthrough to direct delete */ }
    }
    // Direct delete (subtask, note, or master with no children)
    try { await del(`/plan/task/${id}?action=cascade`); } catch { /* */ }
    await loadTasks(true);
    onRefreshAll();
  }

  async function confirmDelete(action: "promote" | "cascade" | "orphan") {
    if (!deleteDialog) return;
    try { await del(`/plan/task/${deleteDialog.taskId}?action=${action}`); } catch { /* */ }
    setDeleteDialog(null);
    await loadTasks(true);
    onRefreshAll();
  }

  async function handleToggle(id: string, complete: boolean) {
    // Optimistic UI update — instant visual feedback
    setTasks(prev => prev.map(t =>
      t.id === id ? { ...t, status: complete ? "completed" : "active", completedAt: complete ? new Date().toISOString() : null } : t
    ));
    try {
      if (complete) await post(`/plan/task/${id}/complete`, {});
      else await post(`/plan/task/${id}/uncomplete`, {});
      await loadTasks(true);
      onRefreshAll();
    } catch {
      // Revert on failure
      setTasks(prev => prev.map(t =>
        t.id === id ? { ...t, status: complete ? "active" : "completed", completedAt: complete ? null : t.completedAt } : t
      ));
    }
  }

  // Drag to reorder — now shows Training Modal instead of immediately saving
  function onDragStart(id: string) { dragTaskRef.current = id; }
  function onDragOver(e: React.DragEvent, id: string) { e.preventDefault(); setDragOverId(id); }
  function onDragLeave() { setDragOverId(null); }

  function onDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    setDragOverId(null);
    // Mark that a drop just happened — the row's onClick handler checks this to avoid opening the detail panel on top of the training modal
    justDroppedRef.current = Date.now();
    const fromId = dragTaskRef.current;
    dragTaskRef.current = null;
    if (!fromId || fromId === targetId) return;

    const fromIdx = tasks.findIndex(t => t.id === fromId);
    const toIdx = tasks.findIndex(t => t.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    // Block cross-category moves with a visible toast (was silently failing, confusing users)
    if (tasks[fromIdx].category !== tasks[toIdx].category) {
      setPlacementToast(`Can't move across categories: "${tasks[fromIdx].category}" → "${tasks[toIdx].category}"`);
      return;
    }

    const prevTasks = [...tasks];
    const newTasks = [...tasks];
    const [moved] = newTasks.splice(fromIdx, 1);
    newTasks.splice(toIdx, 0, moved);

    // Re-calculate sprint IDs immediately for visual update
    const withNewIds = recalcSprintIds(newTasks.map((t, i) => ({ ...t, priorityOrder: i })));
    setTasks(withNewIds);

    // Determine displaced tasks (tasks that were leapfrogged)
    const lo = Math.min(fromIdx, toIdx);
    const hi = Math.max(fromIdx, toIdx);
    const displacedTasks = fromIdx > toIdx
      ? prevTasks.slice(toIdx, fromIdx)     // moved up: leapfrogged tasks between toIdx and fromIdx
      : prevTasks.slice(fromIdx + 1, toIdx + 1); // moved down

    // Show Training Modal
    setPendingDrop({
      movedTask: moved,
      displacedTasks: displacedTasks.slice(0, 5),
      fromIdx,
      toIdx,
      newTasks: withNewIds,
      prevTasks,
    });
    setTrainingExplanation("");
    setAiReflection(null);
  }

  async function submitTraining() {
    if (!pendingDrop || !trainingExplanation.trim()) return;
    setSubmittingTraining(true);
    const movedUp = pendingDrop.toIdx < pendingDrop.fromIdx;
    const updates = pendingDrop.newTasks.map((t, i) => ({ id: t.id, priorityOrder: i }));
    try {
      const result = await post<{ ok: boolean; aiReflection?: string; feedback_id?: string }>("/plan/reorder", {
        items: updates,
        movedItemId: pendingDrop.movedTask.id,
        movedItemTitle: pendingDrop.movedTask.title,
        fromPosition: pendingDrop.fromIdx,
        toPosition: pendingDrop.toIdx,
        displacedItemIds: pendingDrop.displacedTasks.map(t => t.id),
        displacedItemTitles: pendingDrop.displacedTasks.map(t => t.title),
        explanation: trainingExplanation.trim(),
        direction: movedUp ? "up" : "down",
      });
      // Train-now toast — the reorder was just captured as agent_feedback
      // for the tasks agent. Tony can train Coach on it directly.
      showTrainNowToast({
        agent: "tasks",
        feedbackId: result.feedback_id ?? null,
        sourceId: pendingDrop.movedTask.id,
        title: "Reorder saved · brain trained",
        description: "Train the tasks agent on this reorder?",
      });
      if (result.aiReflection) {
        // Success: show AI reflection (acts as success state). Modal stays open
        // until user clicks "Got it ✓".
        setAiReflection(result.aiReflection);
      } else {
        // Success but no reflection (AI call failed server-side or returned
        // empty). Reorder + feedback row are persisted — show a brief success
        // toast, then close.
        setPlacementToast("✓ Saved · brain trained");
        closePendingDrop();
      }
    } catch (err) {
      // Persistence failed — keep modal OPEN, leave optimistic order in place
      // so Tony can retry or hit Cancel (revert). Surface a toast.
      console.error("[BusinessView] submitTraining failed:", err);
      setPlacementToast("⚠ Save failed — try again or Cancel to revert");
    } finally {
      setSubmittingTraining(false);
    }
  }

  function cancelTraining() {
    if (pendingDrop) setTasks(pendingDrop.prevTasks);
    closePendingDrop();
  }

  function closePendingDrop() {
    setPendingDrop(null);
    setTrainingExplanation("");
    setAiReflection(null);
    setSubmittingTraining(false);
  }

  function exportTasksToCsv() {
    const titleById = new Map(tasks.map(t => [t.id, t.title] as const));
    const headers = [
      "Sprint ID", "Type", "Parent", "Task", "Owner", "Co-Owner",
      "Priority", "Status", "Category", "Subcategory", "Execution Tier",
      "Due Date", "Completed Date", "Atomic KPI", "Notes", "Source", "Linear ID",
    ];
    const rows = displayed.map(t => [
      t.sprintId || "",
      t.taskType === "subtask" ? "Sub" : t.taskType === "note" ? "Note" : "Master",
      t.parentTaskId ? (titleById.get(t.parentTaskId) || "") : "",
      t.title,
      t.owner || "",
      t.coOwner || "",
      t.priority || "",
      t.status || "",
      t.category || "",
      t.subcategory || "",
      t.executionTier || "",
      t.dueDate || "",
      t.completedAt ? new Date(t.completedAt).toISOString().slice(0, 10) : "",
      t.atomicKpi || "",
      t.workNotes || "",
      t.source || "",
      t.linearId || "",
    ]);
    const csv = buildCsv(headers, rows);
    const stamp = new Date().toISOString().slice(0, 10);
    const scope = filterCat ? `-${filterCat}` : "";
    downloadBlob(`master-tasks${scope}-${stamp}.csv`, "text/csv;charset=utf-8", csv);
  }

  async function runAiOrganize(mode: "top50" | "all" = "top50") {
    setOrganizing(true);
    try {
      const data = await get<{ tasks: (PlanItem & { sprintId?: string })[]; mode?: string; organizedCount?: number; totalCount?: number }>(`/plan/brain/order?mode=${mode}`);
      if (data.tasks && data.tasks.length > 0) {
        const newOrderWithIds = recalcSprintIds(data.tasks.map((t, i) => ({ ...t, priorityOrder: i })));
        setOrganizePreview({ newOrder: newOrderWithIds, currentOrder: tasks });
      }
    } catch { /**/ }
    setOrganizing(false);
  }

  async function confirmAiOrganize() {
    if (!organizePreview) return;
    setConfirmingOrganize(true);
    const updates = organizePreview.newOrder.map((t, i) => ({ id: t.id, priorityOrder: i }));
    try {
      await post("/plan/reorder", { items: updates });
      // Refetch the full task list rather than replacing local state with the
      // AI-organize response. /plan/brain/order only returns status="active"
      // tasks, but local state holds ALL level="task" rows (including done /
      // not_started / in_qa). Replacing state would silently drop everything
      // that isn't currently active.
      setOrganizePreview(null);
      await loadTasks(true);
    } catch { loadTasks(); }
    setConfirmingOrganize(false);
  }

  function handleAddCreated(result: any) {
    setShowAdd(false);
    loadTasks();
    onRefreshAll();
    setPlacementToast(`✓ ${result.sprintId} added · position ${result.position}/${result.total}${result.prevTask ? ` · after "${result.prevTask.title.split(":")[0].trim()}"` : ""}`);
    // Track the new task's id — the useEffect below will scroll to it and apply a pulse once the row is rendered
    if (result?.task?.id) {
      setJustCreatedId(result.task.id);
    }
  }

  // When a new task is created, scroll its row into view and clear the pulse after 3s
  useEffect(() => {
    if (!justCreatedId) return;
    // Wait one frame for the row ref to attach after loadTasks() re-renders
    const scrollTimer = setTimeout(() => {
      const el = rowRefs.current[justCreatedId];
      if (el?.scrollIntoView) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 150);
    // Clear the pulse highlight after the animation completes (3s total)
    const clearTimer = setTimeout(() => setJustCreatedId(null), 3000);
    return () => { clearTimeout(scrollTimer); clearTimeout(clearTimer); };
  }, [justCreatedId]);

  const selStyle: CSSProperties = { fontSize: 12, padding: "6px 10px", borderRadius: 7, border: `1px solid ${C.brd}`, fontFamily: F, background: C.card };

  // Count tasks per category for the nav bar badges
  const catCounts = CAT_KEYS.reduce<Record<string, number>>((acc, k) => {
    acc[k] = tasks.filter(t => t.category === k).length;
    return acc;
  }, {});

  return (
    <div>
      {/* Keyframes for the "just created" pulse — injected once inside the component */}
      <style>{`
        @keyframes tccRowPulse {
          0%   { background-color: #FFF7ED; box-shadow: inset 0 0 0 2px #F97316, 0 0 0 0 rgba(249,115,22,0.45); }
          40%  { background-color: #FFEDD5; box-shadow: inset 0 0 0 2px #F97316, 0 0 0 6px rgba(249,115,22,0.25); }
          70%  { background-color: #FFF7ED; box-shadow: inset 0 0 0 2px #F97316, 0 0 0 12px rgba(249,115,22,0); }
          100% { background-color: #FFF7ED; box-shadow: inset 0 0 0 2px #F97316, 0 0 0 0 rgba(249,115,22,0); }
        }
        .tcc-row-pulse { animation: tccRowPulse 1.2s ease-out 2; }
      `}</style>

      {/* Sticky header: nav bar + filter row */}
      <div style={{
        position: "sticky", top: 75, zIndex: 30,
        background: "#fff", borderBottom: `2px solid ${C.brd}`,
        paddingBottom: 10,
      }}>

        {/* ── Category nav bar ── */}
        <div style={{
          display: "flex", gap: 0, borderBottom: `1px solid ${C.brd}`,
          marginBottom: 10, overflowX: "auto",
        }}>
          {/* All button */}
          <button
            onClick={() => setFilterCat("")}
            style={{
              padding: "9px 18px", border: "none", cursor: "pointer",
              fontFamily: F, fontSize: 12, fontWeight: filterCat === "" ? 800 : 500,
              color: filterCat === "" ? "#F97316" : C.sub,
              background: "transparent",
              borderBottom: filterCat === "" ? "3px solid #F97316" : "3px solid transparent",
              whiteSpace: "nowrap", transition: "all 0.15s",
            }}
          >All · {tasks.length}</button>

          {CAT_KEYS.map(k => {
            const active = filterCat === k;
            const color = CAT_COLOR[k] ?? C.sub;
            return (
              <button
                key={k}
                onClick={() => setFilterCat(active ? "" : k)}
                style={{
                  padding: "9px 18px", border: "none", cursor: "pointer",
                  fontFamily: F, fontSize: 12, fontWeight: active ? 800 : 500,
                  color: active ? color : C.sub,
                  background: "transparent",
                  borderBottom: active ? `3px solid ${color}` : "3px solid transparent",
                  whiteSpace: "nowrap", transition: "all 0.15s",
                }}
              >
                {CAT_LABELS[k]} · {catCounts[k] ?? 0}
              </button>
            );
          })}
        </div>

        {/* ── Filter row ── */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", minWidth: 180 }}>
            <input
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Search tasks..."
              style={{
                padding: "6px 10px 6px 28px", borderRadius: 8, border: `1px solid ${C.brd}`,
                fontSize: 12, fontFamily: F, color: C.tx, background: C.card, width: "100%",
                outline: "none",
              }}
              onFocus={e => (e.target.style.borderColor = "#F97316")}
              onBlur={e => (e.target.style.borderColor = C.brd)}
            />
            <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: C.mut, pointerEvents: "none" }}>🔍</span>
          </div>
          <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={selStyle}>
            <option value="">All categories</option>
            {CAT_KEYS.map(c => <option key={c} value={c}>{CAT_LABELS[c]}</option>)}
          </select>
          <select value={filterOwner} onChange={e => setFilterOwner(e.target.value)} style={selStyle}>
            <option value="">All owners</option>
            {OWNER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <select value={filterWeek} onChange={e => setFilterWeek(e.target.value)} style={selStyle}>
            <option value="">All weeks</option>
            <option value="1">Week 1</option>
            <option value="2">Week 2</option>
            <option value="3">Week 3</option>
            <option value="4">Week 4</option>
          </select>
          <select value={filterParent} onChange={e => setFilterParent(e.target.value)} style={selStyle}>
            <option value="">All parents</option>
            {allMasters.map(m => (
              <option key={m.id} value={m.id}>
                {m.sprintId ? `${m.sprintId} — ` : ""}{(m.title || "").slice(0, 60)}
              </option>
            ))}
          </select>
          {anyExpandable && (
            <button
              type="button"
              onClick={() => {
                if (anyCollapsed) {
                  setCollapsedIds(new Set());
                } else {
                  const allMasterIds = new Set(tasks.filter(t => (t.taskType ?? "master") === "master" && (childCountByMaster.get(t.id) ?? 0) > 0).map(t => t.id));
                  setCollapsedIds(allMasterIds);
                }
              }}
              title={anyCollapsed ? "Expand all masters" : "Collapse all masters"}
              style={{
                padding: "4px 11px", borderRadius: 20, border: `1px solid ${C.brd}`,
                background: "transparent", color: C.sub, fontSize: 11, fontWeight: 600,
                cursor: "pointer", fontFamily: F, whiteSpace: "nowrap",
              }}
            >
              {anyCollapsed ? "▼ Expand all" : "▶ Collapse all"}
            </button>
          )}
          {/* Priority chips */}
          {[["", "All"], ["P0", "P0"], ["P1", "P1"], ["P2", "P2"]].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setFilterPriority(val)}
              style={{
                padding: "4px 11px", borderRadius: 20, border: `1px solid ${filterPriority === val ? C.blu : C.brd}`,
                background: filterPriority === val ? C.bluBg : "transparent",
                color: filterPriority === val ? C.blu : C.sub, fontSize: 11, fontWeight: 600,
                cursor: "pointer", fontFamily: F, whiteSpace: "nowrap",
              }}
            >{label}</button>
          ))}
          {/* Status chips */}
          {[["", "All"], ["pending", "Not Started"], ["active", "Active"], ["completed", "Done"]].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setFilterStatus(val)}
              style={{
                padding: "4px 11px", borderRadius: 20,
                border: `1px solid ${filterStatus === val ? (val === "completed" ? C.grn : val === "pending" ? C.amb : val === "active" ? C.blu : C.brd) : C.brd}`,
                background: filterStatus === val ? (val === "completed" ? C.grnBg : val === "pending" ? C.ambBg : val === "active" ? C.bluBg : C.card) : "transparent",
                color: filterStatus === val ? (val === "completed" ? C.grn : val === "pending" ? C.amb : val === "active" ? C.blu : C.tx) : C.sub,
                fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: F, whiteSpace: "nowrap",
              }}
            >{label}</button>
          ))}
          {/* Linear-only filter */}
          <button
            type="button"
            onClick={() => setFilterLinearOnly(v => !v)}
            title="Show only tasks tied to a Linear ticket"
            style={{
              padding: "4px 11px", borderRadius: 20,
              border: `1px solid ${filterLinearOnly ? "#5E6AD2" : C.brd}`,
              background: filterLinearOnly ? "#EEF0FB" : "transparent",
              color: filterLinearOnly ? "#5E6AD2" : C.sub,
              fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: F, whiteSpace: "nowrap",
            }}
          >◼ Linear only</button>
          {/* Highlight filter — "Any" shows all highlighted; specific color narrows to that. */}
          {(() => {
            const active = !!filterHighlight;
            const activeHex = filterHighlight && filterHighlight !== "any" ? highlightHex(filterHighlight) : null;
            return (
              <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
                <select
                  value={filterHighlight}
                  onChange={e => setFilterHighlight(e.target.value)}
                  title="Filter to highlighted tasks (any color or a specific one)"
                  style={{
                    padding: "4px 11px", paddingLeft: activeHex ? 26 : 11, borderRadius: 20,
                    border: `1px solid ${active ? (activeHex || "#F59E0B") : C.brd}`,
                    background: active ? (activeHex ? `${activeHex}18` : "#FEF3C7") : "transparent",
                    color: active ? (activeHex || "#92400E") : C.sub,
                    fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: F, whiteSpace: "nowrap",
                    appearance: "none", WebkitAppearance: "none", MozAppearance: "none",
                  }}
                >
                  <option value="">★ All</option>
                  <option value="any">★ Any highlight</option>
                  {HIGHLIGHT_COLORS.map(c => (
                    <option key={c.value} value={c.value}>● {c.label}</option>
                  ))}
                </select>
                {activeHex && (
                  <span style={{
                    position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
                    width: 10, height: 10, borderRadius: "50%", background: activeHex,
                    pointerEvents: "none", border: "1px solid rgba(0,0,0,0.15)",
                  }} />
                )}
              </div>
            );
          })()}
          <span style={{ marginLeft: "auto", fontSize: 11, color: C.mut }}>
            {loading ? "Loading…" : `${displayed.length} tasks`}
          </span>
          <span style={{ fontSize: 10, color: C.mut, fontFamily: F }}>⠿ drag rows to reorder</span>
          {tasks.length >= 50 && (
            <button
              onClick={() => runAiOrganize("top50")}
              disabled={organizing || loading}
              title="Re-rank the top 50 active tasks by current priority — faster, stays well within Vercel's 300s function limit."
              style={{
                padding: "7px 14px", borderRadius: 8, border: `1px solid ${C.blu}`,
                background: organizing ? C.bluBg : C.bluBg, color: C.blu,
                fontSize: 12, fontWeight: 700, cursor: organizing ? "wait" : "pointer", fontFamily: F,
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              {organizing ? "🧠 Thinking…" : "🧠 AI Organize · Top 50"}
            </button>
          )}
          <button
            onClick={() => runAiOrganize("all")}
            disabled={organizing || loading || tasks.length === 0}
            title={tasks.length === 0
              ? "No active tasks to organize"
              : tasks.length < 50
                ? `Re-rank all ${tasks.length} active tasks`
                : `Re-rank ALL ${tasks.length} active tasks (slower — may take 2-4 minutes for 200+ tasks)`}
            style={{
              padding: "7px 14px", borderRadius: 8,
              border: tasks.length < 50 ? `1px solid ${C.blu}` : `1px solid ${C.mut}`,
              background: tasks.length < 50 ? C.bluBg : "transparent",
              color: tasks.length < 50 ? C.blu : C.mut,
              fontSize: tasks.length < 50 ? 12 : 11,
              fontWeight: tasks.length < 50 ? 700 : 600,
              cursor: (organizing || loading || tasks.length === 0) ? "not-allowed" : "pointer",
              fontFamily: F,
              display: "flex", alignItems: "center", gap: 4,
              opacity: (organizing || loading || tasks.length === 0) ? 0.45 : 1,
            }}
          >
            {tasks.length < 50
              ? (organizing ? "🧠 Thinking…" : "🧠 Organize Tasks")
              : `🧠 Organize all ${tasks.length}`}
          </button>
          <button
            onClick={exportTasksToCsv}
            disabled={loading || displayed.length === 0}
            title={`Export ${displayed.length} task${displayed.length === 1 ? "" : "s"} as CSV (opens in Excel)`}
            style={{
              padding: "7px 14px", borderRadius: 8, border: `1px solid ${C.grn}`,
              background: C.grnBg, color: C.grn,
              fontSize: 12, fontWeight: 700,
              cursor: loading || displayed.length === 0 ? "not-allowed" : "pointer",
              fontFamily: F, opacity: loading || displayed.length === 0 ? 0.5 : 1,
            }}
          >
            📥 Export
          </button>
          <button onClick={() => setShowAdd(true)} style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: "#F97316", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: F }}>+ Add task</button>
        </div>
      </div>

      {/* Table — full-width, scrollable */}
      <div style={{ overflowX: "auto", borderRadius: "0 0 10px 10px", border: `1px solid ${C.brd}`, marginTop: 12 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1400 }}>
          <thead>
            <tr style={{ background: C.card, borderBottom: `2px solid ${C.brd}` }}>
              {["","Type","Sprint ID","Tier","Category","Sub-Category","Task","Atomic KPI","Owner","Co-Owner","Source","Priority","Status","Due Date","Completed","Notes","Linear",""].map((h, i) => (
                <th key={i} onClick={() => {
                  if (!h) return;
                  if (sortCol === h) setSortDir(d => d === "asc" ? "desc" : "asc");
                  else { setSortCol(h); setSortDir("asc"); }
                }} style={{ position: "sticky", top: 0, background: C.card, fontSize: 10, fontWeight: 700, color: sortCol === h ? "#F97316" : C.sub, textAlign: "left", padding: "8px 10px", whiteSpace: "nowrap", borderRight: `1px solid ${C.brd}`, borderBottom: `2px solid ${C.brd}`, zIndex: 10, cursor: h ? "pointer" : "default", userSelect: "none" }}>
                  {h}{sortCol === h ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && displayed.length === 0 && (
              [0, 1, 2, 3, 4, 5, 6, 7].map(i => (
                <tr key={`sk-${i}`} style={{ background: i % 2 === 0 ? "#fff" : "#FAFAFA", borderBottom: `1px solid ${C.brd}` }}>
                  {Array.from({ length: 18 }).map((_, j) => (
                    <td key={j} style={{ padding: "10px 10px", borderRight: `1px solid ${C.brd}` }}>
                      <div style={{
                        height: 10,
                        background: j === 6 ? "#EEE" : "#F2F2F2",
                        borderRadius: 3,
                        width: j === 0 ? 14 : j === 6 ? "85%" : j === 7 ? "70%" : "60%",
                      }} />
                    </td>
                  ))}
                </tr>
              ))
            )}
            {displayed.map((task) => {
              const done = task.status === "completed";
              const isLate = !done && task.dueDate && new Date(task.dueDate) < new Date("2026-04-09");
              const isDraggingOver = dragOverId === task.id;
              // Highlight feature: tint whole row with the highlight color at ~13%
              // opacity. Drag-over / done / late states still win to preserve
              // user-facing affordances.
              const hlHex = highlightHex(task.highlightColor);
              const baseBg = isDraggingOver ? "#EFF6FF" : done ? "#F9FFF9" : isLate ? "#FFF8F8" : "#fff";
              const rowBg = hlHex && !isDraggingOver && !done && !isLate ? `${hlHex}22` : baseBg;
              const pc = personColor(task.owner || "");

              const isJustCreated = task.id === justCreatedId;
              return (
                <tr
                  key={task.id}
                  ref={el => { rowRefs.current[task.id] = el; }}
                  className={isJustCreated ? "tcc-row-pulse" : undefined}
                  draggable
                  onDragStart={() => onDragStart(task.id)}
                  onDragOver={e => onDragOver(e, task.id)}
                  onDragLeave={onDragLeave}
                  onDrop={e => onDrop(e, task.id)}
                  onClick={() => {
                    // Suppress click if a drag-drop just fired (prevents the detail panel from opening on top of the training modal)
                    if (Date.now() - justDroppedRef.current < 300) return;
                    setSelectedTask(task);
                  }}
                  onMouseEnter={e => {
                    if (hoverTimer.current) clearTimeout(hoverTimer.current);
                    const x = e.clientX; const y = e.clientY;
                    hoverTimer.current = setTimeout(() => setHoverInfo({ task, x, y }), 500);
                  }}
                  onMouseMove={e => {
                    if (hoverInfo) setHoverInfo(h => h ? { ...h, x: e.clientX, y: e.clientY } : null);
                  }}
                  onMouseLeave={() => {
                    if (hoverTimer.current) clearTimeout(hoverTimer.current);
                    setHoverInfo(null);
                  }}
                  style={{
                    background: isJustCreated ? "#FFF7ED" : rowBg,
                    borderBottom: `1px solid ${C.brd}`,
                    borderTop: isDraggingOver ? `2px solid ${C.blu}` : undefined,
                    transition: "background 0.3s",
                    cursor: "pointer",
                    boxShadow: isJustCreated ? "inset 0 0 0 2px #F97316" : undefined,
                  }}
                >
                  {/* Drag + checkbox combined */}
                  <td onClick={e => e.stopPropagation()} style={{ padding: "6px 8px", textAlign: "center", cursor: "grab", color: C.mut, fontSize: 14, whiteSpace: "nowrap" }}>
                    <span style={{ marginRight: 4, opacity: 0.4 }}>⠿</span>
                    {task.taskType !== "note" && (
                      <button
                        onClick={e => { e.stopPropagation(); handleToggle(task.id, !done); }}
                        style={{ width: 15, height: 15, borderRadius: 3, border: `1.5px solid ${done ? C.grn : "#d1d5db"}`, background: done ? C.grn : "transparent", color: "#fff", fontSize: 8, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                      >{done ? "✓" : ""}</button>
                    )}
                  </td>
                  {/* Type (with collapse chevron on masters that have children) */}
                  <td style={{ padding: "8px 10px", fontSize: 11, whiteSpace: "nowrap" }} onClick={e => e.stopPropagation()}>
                    {(task.taskType ?? "master") === "master" && (() => {
                      const kidCount = childCountByMaster.get(task.id) ?? 0;
                      const collapsed = collapsedIds.has(task.id);
                      return (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          {kidCount > 0 ? (
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); toggleCollapse(task.id); }}
                              title={collapsed ? `Expand ${kidCount} child${kidCount === 1 ? "" : "ren"}` : "Collapse"}
                              style={{
                                background: "transparent", border: "none", cursor: "pointer",
                                color: "#F97316", fontSize: 10, padding: 0, width: 14, height: 14,
                                display: "inline-flex", alignItems: "center", justifyContent: "center",
                                transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
                                transition: "transform 0.15s",
                              }}
                            >▼</button>
                          ) : (
                            <span style={{ width: 14, display: "inline-block" }}></span>
                          )}
                          <span style={{ color: "#F97316", fontWeight: 700 }}>📌 Master</span>
                          {kidCount > 0 && <span style={{ color: C.mut, fontWeight: 500, fontSize: 10 }}>· {kidCount}</span>}
                        </span>
                      );
                    })()}
                    {task.taskType === "subtask" && <span style={{ color: C.sub, fontWeight: 500 }}>↳ Sub</span>}
                    {task.taskType === "note" && <span style={{ color: C.mut, fontWeight: 500, fontStyle: "italic" }}>📝 Note</span>}
                  </td>
                  {/* Sprint ID */}
                  <td style={{ padding: "8px 10px", fontSize: 11, fontWeight: 700, color: C.sub, fontFamily: "monospace", whiteSpace: "nowrap" }}>{task.sprintId || "—"}</td>
                  {/* Tier */}
                  <td style={{ padding: "8px 10px", fontSize: 11, color: C.sub, whiteSpace: "nowrap" }}>{task.executionTier || "—"}</td>
                  {/* Category */}
                  <td style={{ padding: "8px 10px" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, textTransform: "capitalize", color: C.tx }}>{task.category}</span>
                  </td>
                  {/* Subcategory */}
                  <td style={{ padding: "8px 10px", fontSize: 11, color: C.sub }}>{task.subcategory || "—"}</td>
                  {/* Task title — with tree indent for subs/notes.
                      overflowWrap: anywhere lets long URLs (no whitespace)
                      break mid-string so the cell respects maxWidth instead of
                      bleeding into adjacent columns.
                      Highlight feature (Tony's 2026-05-16): the row background
                      is tinted with the highlight color (see rowBg above), and
                      the title gets a small colored circle for quick scanning.
                      The full highlight note appears in the row's hover card. */}
                  <td style={{
                    padding: "8px 10px", maxWidth: 220, minWidth: 140,
                    overflowWrap: "anywhere", wordBreak: "break-word",
                  }}>
                    <span style={{
                      fontSize: task.taskType === "note" ? 11 : 12,
                      color: done ? C.mut : task.taskType === "note" ? C.sub : C.tx,
                      textDecoration: done ? "line-through" : "none",
                      lineHeight: 1.4,
                      display: "block",
                      paddingLeft: (task.taskType === "subtask" || task.taskType === "note") ? 20 : 0,
                      fontStyle: task.taskType === "note" ? "italic" : "normal",
                      fontWeight: (task.taskType ?? "master") === "master" ? 600 : 400,
                    }}>
                      {(task.taskType === "subtask" || task.taskType === "note") && <span style={{ color: C.mut, marginRight: 4 }}>↳</span>}
                      {highlightHex(task.highlightColor) && (
                        <span
                          style={{
                            display: "inline-block",
                            width: 9, height: 9, borderRadius: "50%",
                            background: highlightHex(task.highlightColor) || undefined,
                            marginRight: 6, verticalAlign: "middle",
                            border: "1px solid rgba(0,0,0,0.15)",
                          }}
                        />
                      )}
                      {task.title}
                    </span>
                  </td>
                  {/* Atomic KPI — same wrap treatment so long KPI text doesn't bleed. */}
                  <td style={{ padding: "8px 10px", maxWidth: 160, fontSize: 11, color: C.sub, overflowWrap: "anywhere", wordBreak: "break-word" }}>{task.atomicKpi || "—"}</td>
                  {/* Owner */}
                  <td style={{ padding: "8px 10px" }}>
                    {task.owner && <span style={{ fontSize: 11, fontWeight: 700, color: pc, background: pc + "18", borderRadius: 8, padding: "1px 7px", whiteSpace: "nowrap" }}>{task.owner}</span>}
                  </td>
                  {/* Co-Owner — read-only in table, editable in detail modal */}
                  <td style={{ padding: "8px 10px", fontSize: 11, color: C.sub, whiteSpace: "nowrap" }}>{task.coOwner || "—"}</td>
                  {/* Source */}
                  <td style={{ padding: "8px 10px", fontSize: 11, color: C.mut, whiteSpace: "nowrap" }}>{task.source || "—"}</td>
                  {/* Priority */}
                  <td style={{ padding: "8px 10px" }}>{task.priority && <PriorityBadge p={task.priority} />}</td>
                  {/* Status */}
                  <td style={{ padding: "8px 10px" }}>{task.status && <StatusPill s={isLate ? "late" : task.status} />}</td>
                  {/* Due date */}
                  <td style={{ padding: "8px 10px", fontSize: 11, color: isLate ? C.red : C.mut, whiteSpace: "nowrap" }}>{task.dueDate || "—"}</td>
                  {/* Completed date */}
                  <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                    {task.completedAt ? (
                      <span style={{ fontSize: 11, color: C.grn, fontWeight: 600 }}>
                        ✓ {new Date(task.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </span>
                    ) : <span style={{ color: C.mut, fontSize: 11 }}>—</span>}
                  </td>
                  {/* Notes */}
                  <td style={{ padding: "8px 10px", fontSize: 11, color: C.sub, maxWidth: 100 }}>{task.workNotes || "—"}</td>
                  {/* Linear — supports multiple IDs via comma-separated list */}
                  <td style={{ padding: "8px 10px", fontSize: 11 }} onClick={e => e.stopPropagation()}>
                    {(() => {
                      const ids = splitLinearIds(task.linearId);
                      if (ids.length === 0) return <span style={{ color: C.mut }}>—</span>;
                      return (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {ids.map((id, i) => (
                            <a
                              key={id + i}
                              href={`https://linear.app/issue/${id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: C.blu, textDecoration: "none", borderBottom: `1px dotted ${C.blu}` }}
                            >{id}</a>
                          ))}
                        </div>
                      );
                    })()}
                  </td>
                  {/* Delete */}
                  <td onClick={e => e.stopPropagation()} style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                    <button
                      onClick={e => { e.stopPropagation(); handleDeleteTask(task.id); }}
                      title="Delete task"
                      style={{ background: "none", border: "none", color: C.mut, cursor: "pointer", fontSize: 14, padding: 2 }}
                      onMouseEnter={e => (e.currentTarget.style.color = C.red)}
                      onMouseLeave={e => (e.currentTarget.style.color = C.mut)}
                    >🗑</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && displayed.length === 0 && (
          <div style={{ padding: "32px", textAlign: "center", color: C.mut, fontFamily: F, fontSize: 14 }}>No tasks found</div>
        )}
      </div>

      {showAdd && (
        <AddTaskModal
          onClose={() => { setShowAdd(false); setPrefillData(null); }}
          onCreated={handleAddCreated}
          categories={categories}
          prefill={prefillData}
          allTasks={tasks}
        />
      )}

      {/* Delete-confirmation dialog — shown when deleting a Master task with children */}
      {deleteDialog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 10001, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setDeleteDialog(null); }}>
          <div style={{ background: "#fff", borderRadius: 12, width: 460, maxWidth: "92vw", padding: 24, boxShadow: "0 16px 48px rgba(0,0,0,0.24)" }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.tx, fontFamily: F, marginBottom: 6 }}>Delete Master Task</div>
            <div style={{ fontSize: 13, color: C.sub, fontFamily: F, marginBottom: 4 }}>"{deleteDialog.taskTitle}"</div>
            <div style={{ fontSize: 12, color: C.mut, fontFamily: F, marginBottom: 16 }}>
              This master has {deleteDialog.subCount} sub-task{deleteDialog.subCount === 1 ? "" : "s"}
              {deleteDialog.noteCount > 0 && ` and ${deleteDialog.noteCount} note${deleteDialog.noteCount === 1 ? "" : "s"}`}.
              What should happen to {deleteDialog.subCount + deleteDialog.noteCount === 1 ? "it" : "them"}?
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
              <button
                onClick={() => confirmDelete("promote")}
                style={{ padding: "10px 14px", borderRadius: 8, border: `1.5px solid ${C.grn}`, background: C.grnBg, color: C.grn, fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "left", fontFamily: F }}
              >
                📌 Promote sub-tasks to Master
                <div style={{ fontSize: 11, fontWeight: 400, color: C.sub, marginTop: 2 }}>Sub-tasks become independent; notes will be deleted (no context without parent)</div>
              </button>
              <button
                onClick={() => confirmDelete("cascade")}
                style={{ padding: "10px 14px", borderRadius: 8, border: `1.5px solid ${C.red}`, background: C.redBg, color: C.red, fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "left", fontFamily: F }}
              >
                🗑 Delete all children with parent
                <div style={{ fontSize: 11, fontWeight: 400, color: C.sub, marginTop: 2 }}>Cascade delete — everything under this master is removed</div>
              </button>
              <button
                onClick={() => confirmDelete("orphan")}
                style={{ padding: "10px 14px", borderRadius: 8, border: `1.5px solid ${C.brd}`, background: C.card, color: C.tx, fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "left", fontFamily: F }}
              >
                👻 Keep as orphans
                <div style={{ fontSize: 11, fontWeight: 400, color: C.sub, marginTop: 2 }}>Children stay with dangling parent reference — shown in an "Orphaned" group at the bottom</div>
              </button>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={() => setDeleteDialog(null)}
                style={{ padding: "8px 18px", borderRadius: 7, border: `1px solid ${C.brd}`, background: "transparent", color: C.sub, fontSize: 12, cursor: "pointer", fontFamily: F }}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}

      {placementToast && <Toast msg={placementToast} onDismiss={() => setPlacementToast(null)} />}

      {/* Hover tooltip — shows after 500ms hover */}
      {hoverInfo && !selectedTask && (() => {
        const t = hoverInfo.task;
        const catColor = CAT_COLOR[t.category] ?? "#555";
        const wx = typeof window !== "undefined" ? window.innerWidth : 1400;
        const wy = typeof window !== "undefined" ? window.innerHeight : 800;
        const left = hoverInfo.x + 20 + 320 > wx ? hoverInfo.x - 340 : hoverInfo.x + 20;
        const top = Math.min(hoverInfo.y - 10, wy - 280);
        return (
          <div style={{
            position: "fixed", left, top, zIndex: 8000,
            width: 320, background: "#fff", borderRadius: 10,
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)", border: `1px solid ${C.brd}`,
            pointerEvents: "none",
          }}>
            <div style={{ background: catColor, borderRadius: "10px 10px 0 0", padding: "10px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.75)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>
                {t.sprintId && `${t.sprintId} · `}{t.category}{t.subcategory ? ` · ${t.subcategory}` : ""}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", lineHeight: 1.4 }}>{t.title}</div>
            </div>
            <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {t.priority && <PriorityBadge p={t.priority} />}
                {t.status && <StatusPill s={t.status} />}
                {t.owner && <span style={{ fontSize: 10, fontWeight: 700, color: catColor }}>{t.owner}</span>}
              </div>
              {t.dueDate && <div style={{ fontSize: 11, color: C.mut }}>Due: <strong>{t.dueDate}</strong></div>}
              {t.completedAt && <div style={{ fontSize: 11, color: C.grn, fontWeight: 600 }}>✓ Completed {new Date(t.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>}
              {/* Highlight section — shown first when present so Tony sees
                  the focus marker before everything else (the row is also
                  tinted in the master list to reinforce). */}
              {t.highlightColor && (() => {
                const hex = highlightHex(t.highlightColor) || "#888";
                return (
                  <div style={{
                    marginTop: -2,
                    padding: "6px 9px",
                    background: `${hex}18`,
                    borderLeft: `3px solid ${hex}`,
                    borderRadius: 4,
                  }}>
                    <div style={{ fontSize: 9, fontWeight: 800, color: hex, textTransform: "uppercase", letterSpacing: 0.5, display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: hex }} />
                      Highlighted ({t.highlightColor})
                    </div>
                    {t.highlightNote && (
                      <div style={{ fontSize: 12, color: C.tx, marginTop: 3, lineHeight: 1.45 }}>{t.highlightNote}</div>
                    )}
                  </div>
                );
              })()}
              {t.atomicKpi && (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5 }}>Atomic KPI</div>
                  <div style={{ fontSize: 12, color: C.tx, marginTop: 2 }}>{t.atomicKpi}</div>
                </div>
              )}
              {t.workNotes && (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5 }}>Notes</div>
                  <div style={{ fontSize: 12, color: C.tx, marginTop: 2, lineHeight: 1.5 }}>{t.workNotes}</div>
                </div>
              )}
              {!t.atomicKpi && !t.workNotes && !t.highlightColor && <div style={{ fontSize: 11, color: C.mut, fontStyle: "italic" }}>Click to add notes →</div>}
            </div>
          </div>
        );
      })()}

      {/* Click-to-edit detail panel */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onSaved={() => { loadTasks(); onRefreshAll(); }}
        />
      )}

      {/* ─── Training Modal ─────────────────────────────────────────────── */}
      {pendingDrop && !aiReflection && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9000 }}>
          <div style={{ background: C.card, borderRadius: 16, padding: 32, width: 520, maxWidth: "94vw", boxShadow: "0 24px 80px rgba(0,0,0,0.5)", border: `1px solid ${C.brd}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10 }}>🧠 Brain Training</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.tx, fontFamily: F, marginBottom: 4 }}>
              Moving <span style={{ color: pendingDrop.toIdx < pendingDrop.fromIdx ? C.blu : C.mut }}>"{pendingDrop.movedTask.title}"</span>
            </div>
            {pendingDrop.displacedTasks.length > 0 && (
              <div style={{ fontSize: 12, color: C.mut, marginBottom: 16 }}>
                <span>{pendingDrop.toIdx < pendingDrop.fromIdx ? "above " : "below "}</span>
                {pendingDrop.displacedTasks.slice(0, 3).map((t, i) => (
                  <span key={t.id}>{i > 0 ? ", " : ""}<em style={{ color: C.tx }}>"{t.title}"</em></span>
                ))}
                {pendingDrop.displacedTasks.length > 3 && <span> +{pendingDrop.displacedTasks.length - 3} more</span>}
              </div>
            )}
            <div style={{ fontSize: 13, color: pendingDrop.toIdx < pendingDrop.fromIdx ? C.blu : C.mut, marginBottom: 10, fontWeight: 700 }}>
              {pendingDrop.toIdx < pendingDrop.fromIdx ? "⬆️ Why is it MORE important right now?" : "⬇️ Why is it LESS important right now?"}
            </div>
            <textarea
              autoFocus
              value={trainingExplanation}
              onChange={e => setTrainingExplanation(e.target.value)}
              placeholder={pendingDrop.toIdx < pendingDrop.fromIdx
                ? "e.g. This unblocks our biggest deal this week. Revenue before process."
                : "e.g. Operator stability is more urgent. This can wait until next sprint."}
              rows={4}
              style={{
                width: "100%", boxSizing: "border-box", background: C.bg, border: `1px solid ${C.brd}`,
                borderRadius: 8, padding: "10px 12px", color: C.tx, fontSize: 13, fontFamily: F,
                resize: "vertical", outline: "none",
              }}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitTraining(); }}
            />
            <div style={{ fontSize: 10, color: C.mut, marginTop: 4, marginBottom: 20 }}>⌘/Ctrl+Enter to submit · Your reasoning trains the AI</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={cancelTraining} disabled={submittingTraining} style={{ padding: "9px 20px", borderRadius: 8, border: `1px solid ${C.brd}`, background: "transparent", color: C.mut, fontSize: 13, cursor: "pointer", fontFamily: F }}>Cancel (revert)</button>
              <button
                onClick={submitTraining}
                disabled={!trainingExplanation.trim() || submittingTraining}
                style={{
                  padding: "9px 24px", borderRadius: 8, border: "none",
                  background: !trainingExplanation.trim() || submittingTraining ? C.brd : C.blu,
                  color: "#fff", fontSize: 13, fontWeight: 700, cursor: !trainingExplanation.trim() ? "not-allowed" : "pointer", fontFamily: F,
                }}
              >
                {submittingTraining ? "Saving + reflecting…" : "Log & Save →"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── AI Reflection (after training log submit) ───────────────────── */}
      {pendingDrop && aiReflection && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9001 }}>
          <div style={{ background: C.card, borderRadius: 16, padding: 32, width: 500, maxWidth: "94vw", boxShadow: "0 24px 80px rgba(0,0,0,0.5)", border: `1px solid ${C.brd}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 14 }}>🧠 Brain reflection</div>
            <div style={{ fontSize: 14, color: C.tx, lineHeight: 1.7, marginBottom: 8, fontStyle: "italic", borderLeft: `3px solid ${C.blu}`, paddingLeft: 14 }}>{aiReflection}</div>
            <div style={{ fontSize: 11, color: C.mut, marginBottom: 20 }}>Not quite right? Edit your reasoning and resubmit to refine the reflection.</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setAiReflection(null)}
                style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.brd}`, background: "transparent", color: C.sub, fontSize: 13, cursor: "pointer", fontFamily: F }}
              >✏️ Re-correct</button>
              <button onClick={closePendingDrop} style={{ padding: "9px 24px", borderRadius: 8, border: "none", background: C.blu, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: F }}>Got it ✓</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── AI Organize Preview ─────────────────────────────────────────── */}
      {organizePreview && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.70)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9002 }}>
          <div style={{ background: C.card, borderRadius: 16, padding: 28, width: 640, maxWidth: "96vw", maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 24px 80px rgba(0,0,0,0.5)", border: `1px solid ${C.brd}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 4 }}>🧠 AI Organize Preview</div>
            <div style={{ fontSize: 13, color: C.mut, marginBottom: 16 }}>
              Claude re-ranked your tasks based on revenue impact, urgency, and your training history.
              <span style={{ marginLeft: 12, color: C.grn, fontWeight: 600 }}>▲ moved up</span>
              <span style={{ marginLeft: 8, color: C.amb, fontWeight: 600 }}>▼ moved down</span>
            </div>
            <div style={{ flex: 1, overflow: "auto" }}>
              {organizePreview.newOrder.slice(0, 40).map((t, i) => {
                const oldIdx = organizePreview.currentOrder.findIndex(c => c.id === t.id);
                const moved = oldIdx - i;
                const upColor = C.grn;
                const dnColor = C.amb;
                const moveBadge = moved > 0 ? (
                  <span style={{ fontSize: 10, fontWeight: 700, color: upColor, background: C.grnBg, borderRadius: 4, padding: "1px 5px" }}>▲{moved}</span>
                ) : moved < 0 ? (
                  <span style={{ fontSize: 10, fontWeight: 700, color: dnColor, background: C.ambBg, borderRadius: 4, padding: "1px 5px" }}>▼{Math.abs(moved)}</span>
                ) : null;
                const catColor = CAT_COLORS[t.category as keyof typeof CAT_COLORS]?.accent || C.mut;
                return (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderBottom: `1px solid ${C.brd}`, background: moved > 2 ? `${upColor}10` : moved < -2 ? `${dnColor}10` : "transparent", borderRadius: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: 10, color: C.mut, width: 22, textAlign: "right", flexShrink: 0 }}>{i + 1}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: catColor, width: 50, flexShrink: 0 }}>{t.sprintId || t.category?.slice(0, 3).toUpperCase()}</span>
                    <span style={{ flex: 1, fontSize: 12, color: C.tx }}>{t.title}</span>
                    {moveBadge && <span style={{ flexShrink: 0 }}>{moveBadge}</span>}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20, borderTop: `1px solid ${C.brd}`, paddingTop: 16 }}>
              <button onClick={() => setOrganizePreview(null)} style={{ padding: "9px 20px", borderRadius: 8, border: `1px solid ${C.brd}`, background: "transparent", color: C.mut, fontSize: 13, cursor: "pointer", fontFamily: F }}>Discard</button>
              <button
                onClick={confirmAiOrganize}
                disabled={confirmingOrganize}
                style={{ padding: "9px 24px", borderRadius: 8, border: "none", background: C.blu, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: F }}
              >
                {confirmingOrganize ? "Applying…" : "Apply AI Order ✓"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Team Tab ─────────────────────────────────────────────────────────────────

function TeamTab() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(id: string) { setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  const activeCount = TEAM_SOW.filter(m => !m.hiring).length;
  const hiringCount = TEAM_SOW.filter(m => m.hiring).length;
  const burnTotal = TEAM_SOW.filter(m => !m.hiring).reduce((sum, m) => sum + parseInt((m.salary || "$0").replace(/\D/g, "")), 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Active", value: activeCount, bg: C.grnBg, color: C.grn },
          { label: "Hiring", value: hiringCount, bg: C.ambBg, color: C.amb },
          { label: "Monthly burn", value: `$${burnTotal}K`, bg: C.redBg, color: C.red },
        ].map(m => (
          <div key={m.label} style={{ flex: 1, background: m.bg, border: `1px solid ${m.color}40`, borderRadius: 10, padding: "14px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: m.color, fontFamily: F }}>{m.value}</div>
            <div style={{ fontSize: 11, color: m.color, opacity: 0.8 }}>{m.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {TEAM_SOW.map(member => {
          const isExpanded = expanded.has(member.id);
          const pc = personColor(member.id);
          return (
            <div key={member.id} style={{ border: `1px solid ${C.brd}`, borderRadius: 10, overflow: "hidden" }}>
              <button onClick={() => toggle(member.id)} style={{ width: "100%", background: C.card, border: "none", padding: "12px 16px", cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: member.hiring ? C.amb : pc, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
                  {member.hiring ? "?" : member.name[0]}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: C.tx, fontFamily: F }}>{member.name}</span>
                    {member.hiring && <span style={{ fontSize: 10, fontWeight: 700, background: C.ambBg, color: C.amb, borderRadius: 10, padding: "2px 8px" }}>HIRING</span>}
                  </div>
                  <div style={{ fontSize: 12, color: C.sub }}>{member.role}</div>
                </div>
                <span style={{ color: C.mut }}>{isExpanded ? "▲" : "▼"}</span>
              </button>

              {isExpanded && (
                <div style={{ padding: "16px", background: "#fafafa", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: C.grn, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>✓ Scope of Work</div>
                    {member.does.map((item, i) => (
                      <div key={i} style={{ fontSize: 12, color: C.tx, lineHeight: 1.5, borderLeft: `3px solid ${C.grn}`, paddingLeft: 10, marginBottom: 8 }}>{item}</div>
                    ))}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: C.red, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>✕ Doesn't Touch</div>
                    {member.doesNot.map((item, i) => (
                      <div key={i} style={{ fontSize: 12, color: C.tx, lineHeight: 1.5, borderLeft: `3px solid ${C.red}`, paddingLeft: 10, marginBottom: 8 }}>{item}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 24, background: C.ambBg, border: `1px solid ${C.amb}`, borderRadius: 12, padding: "16px 18px" }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.amb, marginBottom: 12, fontFamily: F }}>⚠ AI Gap Analysis — Critical Risks</div>
        {GAP_ANALYSIS.map(g => (
          <div key={g.n} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: C.amb, flexShrink: 0 }}>#{g.n}</span>
            <span style={{ fontSize: 12, color: "#7C3A00", lineHeight: 1.5 }}>{g.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Business Plan Tab ────────────────────────────────────────────────────────
// Hardcoded BUSINESS_PLAN and OAP_NARRATIVE constants used to live here. They
// were moved to artifacts/api-server/src/lib/business-context-defaults.ts and
// are now DB-backed via /business/context/:documentType — single source of
// truth for both the UI and the AI prompts.


// Maps the FE tab key to the documentType that lives in business_context.
// All four docs are DB-backed and editable from this tab — the AI reads
// the same rows, so what Tony types here is what the AI sees.
type BusinessDocKey = "bp" | "oap" | "brain";

const BUSINESS_DOC_META: Record<BusinessDocKey, {
  documentType: string;
  label: string;
  emoji: string;
  blurb: string;
  placeholder: string;
}> = {
  bp: {
    documentType: "business_plan",
    label: "Business Plan",
    emoji: "📋",
    blurb: "The operating brain — north star, priorities, capital strategy. The AI reads this when reasoning about whether something is signal or noise.",
    placeholder: "Paste your operating brain document here…",
  },
  oap: {
    documentType: "90_day_plan",
    label: "90-Day OAP",
    emoji: "🗓",
    blurb: "Current 90-day outcomes, weekly rhythm, accountability. The AI reads this when assessing if a task fits this cycle's priorities.",
    placeholder: "Paste your 90-day plan here…",
  },
  brain: {
    documentType: "brain_context",
    label: "Brain Context",
    emoji: "🧠",
    blurb: "Loose context the AI uses when organizing your sprint — current priorities, constraints, relationships that don't fit in a task. Tony-style.",
    placeholder: `Example:\n\n- Capital is the #1 constraint. Anything that doesn't directly move revenue or reduce burn is noise.\n- DBTM operator is our showcase client — never let them wait.\n- Bondilyn has been waiting 2 weeks for sales materials. That's a P0.\n- Engineering is solid. Don't micromanage Faisal or Haris.\n- Tony's most productive hours are 6–10am. Don't schedule calls before 10am.`,
  },
};

// ─── Linear Priorities (sub-tab inside Master task) ───────────────────────────

type LinearPriority = {
  id: string;
  priorityOrder: number;
  linearRef: string;
  isProject: boolean;
  title: string;
  status: string;
  priority: string;
  owner: string | null;
  team: string | null;
  q2PlanRef: string | null;
  action: string;
  why: string;
  nextStep: string | null;
};

const LP_ACTIONS = ["DO NOW", "KEEP", "PROMOTE", "PAUSE", "DEFER", "KILL"] as const;

const LP_ACTION_COLORS: Record<string, { bg: string; fg: string }> = {
  "DO NOW":  { bg: "#FEE2E2", fg: "#991B1B" },
  "KEEP":    { bg: "#DCFCE7", fg: "#166534" },
  "PROMOTE": { bg: "#DBEAFE", fg: "#1E40AF" },
  "PAUSE":   { bg: "#FEF3C7", fg: "#92400E" },
  "DEFER":   { bg: "#F3F4F6", fg: "#4B5563" },
  "KILL":    { bg: "#F3F4F6", fg: "#6B7280" },
};

function MasterSubTabBar({ value, onChange }: { value: "tasks" | "linear"; onChange: (v: "tasks" | "linear") => void }) {
  const pill = (active: boolean): CSSProperties => ({
    padding: "6px 14px",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: F,
    background: active ? "#1A1A1A" : C.card,
    color: active ? "#fff" : C.sub,
    border: `1px solid ${active ? "#1A1A1A" : C.brd}`,
    borderRadius: 8,
    cursor: "pointer",
  });
  return (
    <div style={{ display: "flex", gap: 8, padding: "8px 0 12px", borderBottom: `1px solid ${C.brd}`, marginBottom: 12 }}>
      <button style={pill(value === "tasks")} onClick={() => onChange("tasks")}>📋 Tasks</button>
      <button style={pill(value === "linear")} onClick={() => onChange("linear")}>⚡ Linear Priorities</button>
    </div>
  );
}

function LinearPriorityActionChip({ action }: { action: string }) {
  const color = LP_ACTION_COLORS[action] || { bg: "#F3F4F6", fg: "#374151" };
  const isKill = action === "KILL";
  return (
    <span style={{
      display: "inline-block",
      padding: "3px 10px",
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      fontFamily: F,
      letterSpacing: 0.3,
      background: color.bg,
      color: color.fg,
      textDecoration: isKill ? "line-through" : "none",
    }}>{action}</span>
  );
}

type LinearPriorityDraft = {
  linearRef: string;
  title: string;
  status: string;
  priority: string;
  owner: string;
  team: string;
  q2PlanRef: string;
  action: string;
  why: string;
  nextStep: string;
};

const EMPTY_LP_DRAFT: LinearPriorityDraft = {
  linearRef: "", title: "", status: "Backlog", priority: "P2",
  owner: "", team: "", q2PlanRef: "", action: "KEEP", why: "", nextStep: "",
};

function LinearPrioritiesTable() {
  const [rows, setRows] = useState<LinearPriority[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterAction, setFilterAction] = useState<string>("");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Partial<LinearPriority>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState<LinearPriorityDraft>(EMPTY_LP_DRAFT);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get("/linear-priorities");
      setRows((data as LinearPriority[]) || []);
    } catch { /**/ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const counts: Record<string, number> = { all: rows.length };
  for (const a of LP_ACTIONS) counts[a] = 0;
  for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1;

  let displayed = rows;
  if (filterAction) displayed = displayed.filter((r) => r.action === filterAction);
  if (search.trim()) {
    const q = search.toLowerCase();
    displayed = displayed.filter((r) =>
      r.title.toLowerCase().includes(q) ||
      r.linearRef.toLowerCase().includes(q) ||
      (r.why || "").toLowerCase().includes(q),
    );
  }

  const startEdit = (r: LinearPriority) => {
    setEditingId(r.id);
    setEdit({ ...r });
  };
  const cancelEdit = () => { setEditingId(null); setEdit({}); };
  const saveEdit = async () => {
    if (!editingId) return;
    try {
      await patch(`/linear-priorities/${editingId}`, edit as Record<string, unknown>);
      await load();
      cancelEdit();
    } catch { /**/ }
  };
  const deleteRow = async (id: string) => {
    if (!confirm("Delete this Linear Priority row?")) return;
    try { await del(`/linear-priorities/${id}`); await load(); } catch { /**/ }
  };
  const openAdd = () => { setDraft(EMPTY_LP_DRAFT); setCreateError(null); setShowAdd(true); };
  const closeAdd = () => { setShowAdd(false); setCreateError(null); };
  const submitAdd = async () => {
    setCreateError(null);
    const trimmedRef = draft.linearRef.trim();
    const trimmedTitle = draft.title.trim();
    if (!trimmedRef || !trimmedTitle || !draft.action) {
      setCreateError("Linear ref, Title, and Action are required.");
      return;
    }
    if (!trimmedRef.startsWith("Project:") && !/^[A-Z]+-\d+$/.test(trimmedRef)) {
      setCreateError("Linear ref must look like 'COM-338' or 'Project: <name>'.");
      return;
    }
    setSaving(true);
    try {
      await post("/linear-priorities", {
        linearRef: trimmedRef,
        title: trimmedTitle,
        status: draft.status.trim(),
        priority: draft.priority.trim(),
        owner: draft.owner.trim() || null,
        team: draft.team.trim() || null,
        q2PlanRef: draft.q2PlanRef.trim() || null,
        action: draft.action,
        why: draft.why.trim(),
        nextStep: draft.nextStep.trim() || null,
      });
      await load();
      closeAdd();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const linearUrl = (ref: string, isProject: boolean) => {
    if (isProject) return null; // projects need Linear org slug we don't have client-side
    if (!/^[A-Z]+-\d+$/.test(ref)) return null;
    return `https://linear.app/flipiq/issue/${ref}`;
  };

  const pill = (active: boolean, c?: { bg: string; fg: string }): CSSProperties => ({
    padding: "5px 12px", fontSize: 12, fontWeight: 600, fontFamily: F,
    background: active ? (c?.bg || "#1A1A1A") : C.card,
    color: active ? (c?.fg || "#fff") : C.sub,
    border: `1px solid ${active ? (c?.fg || "#1A1A1A") : C.brd}`,
    borderRadius: 999, cursor: "pointer",
  });
  const th: CSSProperties = {
    textAlign: "left", padding: "10px 12px", fontSize: 11, fontWeight: 600, color: C.sub,
    borderBottom: `1px solid ${C.brd}`, background: C.bg, textTransform: "uppercase", letterSpacing: 0.4,
    whiteSpace: "nowrap",
  };
  const td: CSSProperties = {
    padding: "10px 12px", fontSize: 13, color: C.tx, borderBottom: `1px solid ${C.brd}`, verticalAlign: "top",
  };

  if (loading) return <div style={{ padding: 24, color: C.mut, fontFamily: F }}>Loading Linear Priorities…</div>;

  return (
    <div style={{ fontFamily: F }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <button style={pill(filterAction === "")} onClick={() => setFilterAction("")}>All · {counts.all}</button>
        {LP_ACTIONS.map((a) => (
          <button key={a} style={pill(filterAction === a, LP_ACTION_COLORS[a])} onClick={() => setFilterAction(a === filterAction ? "" : a)}>
            {a} · {counts[a] || 0}
          </button>
        ))}
        <input
          type="search"
          placeholder="Search title, Linear ID, or why…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            marginLeft: "auto", padding: "6px 12px", fontSize: 13, fontFamily: F,
            border: `1px solid ${C.brd}`, borderRadius: 8, background: C.card, color: C.tx, minWidth: 280,
          }}
        />
        <button
          onClick={openAdd}
          style={{
            padding: "7px 14px", fontSize: 13, fontWeight: 600, fontFamily: F,
            background: "#F97316", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer",
          }}
        >
          + Add Linear Priority
        </button>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 8, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Linear</th>
              <th style={th}>Title</th>
              <th style={th}>Status</th>
              <th style={th}>Priority</th>
              <th style={th}>Owner</th>
              <th style={th}>Team</th>
              <th style={th}>Q2 Plan Ref</th>
              <th style={th}>Action</th>
              <th style={th}>Why</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((r, i) => {
              const isEditing = editingId === r.id;
              const url = linearUrl(r.linearRef, r.isProject);
              return (
                <tr key={r.id} style={{ background: i % 2 === 0 ? C.card : "#FAFAFA" }}>
                  <td style={td}>{i + 1}</td>
                  <td style={td}>
                    {isEditing ? (
                      <input value={edit.linearRef || ""} onChange={(e) => setEdit({ ...edit, linearRef: e.target.value })} style={{ width: 140, fontSize: 12, padding: 4 }} />
                    ) : url ? (
                      <a href={url} target="_blank" rel="noreferrer" style={{ color: C.blu, fontWeight: 600 }}>{r.linearRef}</a>
                    ) : (
                      <span style={{ color: C.sub, fontWeight: 500, fontSize: 12 }}>{r.linearRef}</span>
                    )}
                  </td>
                  <td style={{ ...td, maxWidth: 320 }}>
                    {isEditing ? (
                      <input value={edit.title || ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })} style={{ width: "100%", fontSize: 13, padding: 4 }} />
                    ) : r.title}
                  </td>
                  <td style={td}>
                    {isEditing ? (
                      <input value={edit.status || ""} onChange={(e) => setEdit({ ...edit, status: e.target.value })} style={{ width: 120, fontSize: 12, padding: 4 }} />
                    ) : <span style={{ fontSize: 12, color: C.sub }}>{r.status}</span>}
                  </td>
                  <td style={td}>
                    {isEditing ? (
                      <input value={edit.priority || ""} onChange={(e) => setEdit({ ...edit, priority: e.target.value })} style={{ width: 80, fontSize: 12, padding: 4 }} />
                    ) : <span style={{ fontSize: 12, fontWeight: 600 }}>{r.priority}</span>}
                  </td>
                  <td style={td}>
                    {isEditing ? (
                      <input value={edit.owner || ""} onChange={(e) => setEdit({ ...edit, owner: e.target.value })} style={{ width: 90, fontSize: 12, padding: 4 }} />
                    ) : <span style={{ fontSize: 12, color: r.owner ? personColor(r.owner) : C.mut, fontWeight: 600 }}>{r.owner || "—"}</span>}
                  </td>
                  <td style={td}>
                    {isEditing ? (
                      <input value={edit.team || ""} onChange={(e) => setEdit({ ...edit, team: e.target.value })} style={{ width: 110, fontSize: 12, padding: 4 }} />
                    ) : <span style={{ fontSize: 12, color: C.sub }}>{r.team || "—"}</span>}
                  </td>
                  <td style={td}>
                    {isEditing ? (
                      <input value={edit.q2PlanRef || ""} onChange={(e) => setEdit({ ...edit, q2PlanRef: e.target.value })} style={{ width: 120, fontSize: 12, padding: 4 }} />
                    ) : <span style={{ fontSize: 11, color: C.mut }}>{r.q2PlanRef || "—"}</span>}
                  </td>
                  <td style={td}>
                    {isEditing ? (
                      <select value={edit.action || ""} onChange={(e) => setEdit({ ...edit, action: e.target.value })} style={{ fontSize: 12, padding: 4 }}>
                        {LP_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                    ) : <LinearPriorityActionChip action={r.action} />}
                  </td>
                  <td style={{ ...td, maxWidth: 360, fontSize: 12, color: C.sub }}>
                    {isEditing ? (
                      <textarea value={edit.why || ""} onChange={(e) => setEdit({ ...edit, why: e.target.value })} style={{ width: "100%", fontSize: 12, padding: 4, minHeight: 60 }} />
                    ) : r.why}
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {isEditing ? (
                      <>
                        <button onClick={saveEdit} style={{ marginRight: 6, padding: "4px 10px", fontSize: 12, fontWeight: 600, background: C.grn, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}>Save</button>
                        <button onClick={cancelEdit} style={{ padding: "4px 10px", fontSize: 12, background: C.card, border: `1px solid ${C.brd}`, color: C.sub, borderRadius: 6, cursor: "pointer" }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => startEdit(r)} style={{ marginRight: 6, padding: "4px 8px", fontSize: 12, background: C.card, border: `1px solid ${C.brd}`, color: C.sub, borderRadius: 6, cursor: "pointer" }}>✏</button>
                        <button onClick={() => deleteRow(r.id)} style={{ padding: "4px 8px", fontSize: 12, background: C.card, border: `1px solid ${C.brd}`, color: C.red, borderRadius: 6, cursor: "pointer" }}>🗑</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {displayed.length === 0 && (
              <tr><td colSpan={11} style={{ ...td, textAlign: "center", color: C.mut, padding: 32 }}>No Linear Priorities match the current filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <LinearPriorityAddModal
          draft={draft}
          onChange={setDraft}
          onCancel={closeAdd}
          onSave={submitAdd}
          saving={saving}
          error={createError}
        />
      )}
    </div>
  );
}

function LinearPriorityAddModal({ draft, onChange, onCancel, onSave, saving, error }: {
  draft: LinearPriorityDraft;
  onChange: (d: LinearPriorityDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
}) {
  const inp: CSSProperties = {
    width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.brd}`,
    fontFamily: F, fontSize: 13, background: "#fff", boxSizing: "border-box",
  };
  const lbl: CSSProperties = {
    fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase",
    letterSpacing: 0.4, marginBottom: 4, display: "block",
  };
  const field = (label: string, key: keyof LinearPriorityDraft, opts?: { wide?: boolean; placeholder?: string }) => (
    <div style={{ gridColumn: opts?.wide ? "1 / -1" : "auto" }}>
      <label style={lbl}>{label}</label>
      <input
        style={inp}
        value={draft[key]}
        placeholder={opts?.placeholder}
        onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
      />
    </div>
  );
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, borderRadius: 12, padding: 24, width: "min(720px, 92vw)",
          maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.tx }}>Add Linear Priority</h2>
          <button onClick={onCancel} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: C.mut }}>×</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {field("Linear Ref *", "linearRef", { placeholder: "COM-338 or Project: <name>" })}
          <div>
            <label style={lbl}>Action *</label>
            <select
              style={inp}
              value={draft.action}
              onChange={(e) => onChange({ ...draft, action: e.target.value })}
            >
              {LP_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          {field("Title *", "title", { wide: true, placeholder: "Short ticket title" })}
          {field("Status", "status", { placeholder: "In Progress, Backlog, …" })}
          {field("Priority", "priority", { placeholder: "P0 / P1 / P2 / P3" })}
          {field("Owner", "owner", { placeholder: "Tony, Ethan, Haris, …" })}
          {field("Team", "team", { placeholder: "Command, Management, …" })}
          {field("Q2 Plan Ref", "q2PlanRef", { wide: true, placeholder: "Q2 Plan 2.1.1" })}
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={lbl}>Why (alignment)</label>
            <textarea
              style={{ ...inp, minHeight: 80, resize: "vertical" }}
              value={draft.why}
              placeholder="Why is this on the priority list?"
              onChange={(e) => onChange({ ...draft, why: e.target.value })}
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={lbl}>Next Step</label>
            <textarea
              style={{ ...inp, minHeight: 60, resize: "vertical" }}
              value={draft.nextStep}
              placeholder="Concrete next action"
              onChange={(e) => onChange({ ...draft, nextStep: e.target.value })}
            />
          </div>
        </div>
        {error && (
          <div style={{ marginTop: 12, padding: 10, background: C.redBg, color: C.red, borderRadius: 6, fontSize: 13 }}>{error}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            onClick={onCancel}
            disabled={saving}
            style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600, background: C.card, border: `1px solid ${C.brd}`, color: C.sub, borderRadius: 8, cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            style={{ padding: "8px 16px", fontSize: 13, fontWeight: 600, background: saving ? C.mut : "#F97316", color: "#fff", border: "none", borderRadius: 8, cursor: saving ? "not-allowed" : "pointer" }}
          >
            {saving ? "Saving…" : "Save Priority"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BusinessPlanTab() {
  const [activeDoc, setActiveDoc] = useState<BusinessDocKey>("bp");
  // Per-doc state — content/saving/saved/loading/lastUpdated are tracked
  // separately so editing one doc doesn't blow away another's unsaved work.
  const [contents, setContents] = useState<Record<string, string>>({});
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [lastUpdated, setLastUpdated] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savedFlash, setSavedFlash] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});

  const meta = BUSINESS_DOC_META[activeDoc];
  const dt = meta.documentType;

  useEffect(() => {
    if (contents[dt] !== undefined) return; // already loaded
    setLoading(s => ({ ...s, [dt]: true }));
    get<{ content: string; lastUpdated: string | null }>(`/business/context/${dt}`)
      .then(d => {
        setContents(s => ({ ...s, [dt]: d.content || "" }));
        setOriginals(s => ({ ...s, [dt]: d.content || "" }));
        setLastUpdated(s => ({ ...s, [dt]: d.lastUpdated || null }));
      })
      .catch(() => {
        setContents(s => ({ ...s, [dt]: "" }));
        setOriginals(s => ({ ...s, [dt]: "" }));
      })
      .finally(() => setLoading(s => ({ ...s, [dt]: false })));
  }, [dt, contents]);

  const value = contents[dt] ?? "";
  const isLoading = loading[dt];
  const isSaving = saving[dt];
  const isEditing = editing[dt];
  const isDirty = (originals[dt] ?? "") !== value;
  const isFlashing = savedFlash[dt];
  const updatedAt = lastUpdated[dt];

  async function saveDoc() {
    setSaving(s => ({ ...s, [dt]: true }));
    try {
      await put(`/business/context/${dt}`, { content: value });
      setOriginals(s => ({ ...s, [dt]: value }));
      setLastUpdated(s => ({ ...s, [dt]: new Date().toISOString() }));
      setEditing(s => ({ ...s, [dt]: false }));
      setSavedFlash(s => ({ ...s, [dt]: true }));
      setTimeout(() => setSavedFlash(s => ({ ...s, [dt]: false })), 2500);
    } catch { /**/ }
    setSaving(s => ({ ...s, [dt]: false }));
  }

  function cancelEdit() {
    setContents(s => ({ ...s, [dt]: originals[dt] ?? "" }));
    setEditing(s => ({ ...s, [dt]: false }));
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        {(Object.keys(BUSINESS_DOC_META) as BusinessDocKey[]).map(k => {
          const m = BUSINESS_DOC_META[k];
          const active = activeDoc === k;
          // Brain Context + Linear Priorities use the blue accent (info / triage),
          // Business Plan + 90-Day OAP use the orange accent (strategic).
          const usesBlue = k === "brain";
          return (
            <button key={k} onClick={() => setActiveDoc(k)} style={{
              padding: "7px 14px", borderRadius: 8,
              border: `1px solid ${active ? (usesBlue ? C.blu : "#F97316") : C.brd}`,
              background: active ? (usesBlue ? C.bluBg : "#F97316") : C.card,
              color: active ? (usesBlue ? C.blu : "#fff") : C.sub,
              fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: F,
            }}>{m.emoji} {m.label}</button>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: C.bluBg, border: `1px solid ${C.blu}40`, borderRadius: 10, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 auto", minWidth: 220 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.blu, marginBottom: 4 }}>{meta.emoji} {meta.label}</div>
            <div style={{ fontSize: 12, color: C.tx, lineHeight: 1.6 }}>{meta.blurb}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            {updatedAt && (
              <div style={{ fontSize: 10, color: C.mut, fontStyle: "italic" }}>
                Last updated {new Date(updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </div>
            )}
            {!isEditing && !isLoading && (
              <button onClick={() => setEditing(s => ({ ...s, [dt]: true }))} style={{
                padding: "5px 12px", borderRadius: 6, border: `1px solid ${C.blu}`, background: C.card,
                color: C.blu, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: F,
              }}>✏ Edit</button>
            )}
          </div>
        </div>

        {isLoading ? (
          <div style={{ fontSize: 13, color: C.mut, padding: 24 }}>Loading…</div>
        ) : isEditing ? (
          <textarea
            value={value}
            onChange={e => setContents(s => ({ ...s, [dt]: e.target.value }))}
            placeholder={meta.placeholder}
            rows={20}
            style={{
              width: "100%", boxSizing: "border-box", background: C.card, border: `1px solid ${C.brd}`,
              borderRadius: 10, padding: "16px 18px", color: C.tx, fontSize: 13, fontFamily: "ui-monospace, monospace",
              lineHeight: 1.7, resize: "vertical", outline: "none", minHeight: 320,
            }}
          />
        ) : (
          <div style={{ background: C.card, border: `1px solid ${C.brd}`, borderRadius: 12, padding: "24px 28px" }}>
            {value.trim() ? (
              <pre style={{ fontSize: 12, color: C.tx, fontFamily: "ui-monospace, monospace", lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>{value}</pre>
            ) : (
              <div style={{ fontSize: 13, color: C.mut, fontStyle: "italic" }}>No {meta.label.toLowerCase()} yet — click ✏ Edit to add one.</div>
            )}
          </div>
        )}

        {isEditing && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center" }}>
            {isFlashing && <span style={{ fontSize: 12, color: C.grn, fontWeight: 600 }}>✓ Saved</span>}
            <button
              onClick={cancelEdit}
              disabled={isSaving}
              style={{
                padding: "9px 18px", borderRadius: 8, border: `1px solid ${C.brd}`,
                background: C.card, color: C.sub, fontSize: 13, fontWeight: 600,
                cursor: isSaving ? "not-allowed" : "pointer", fontFamily: F, opacity: isSaving ? 0.5 : 1,
              }}
            >Cancel</button>
            <button
              onClick={saveDoc}
              disabled={isSaving || !isDirty}
              style={{
                padding: "9px 24px", borderRadius: 8, border: "none",
                background: isSaving || !isDirty ? C.brd : C.blu,
                color: "#fff", fontSize: 13, fontWeight: 700,
                cursor: isSaving || !isDirty ? "not-allowed" : "pointer", fontFamily: F,
              }}
            >
              {isSaving ? "Saving…" : `Save ${meta.label}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main BusinessView ────────────────────────────────────────────────────────

export function BusinessView({ onBack, defaultTab, onTabChange }: { onBack: () => void; defaultTab?: Tab; onTabChange?: (tab: Tab) => void }) {
  const [tab, setTabRaw] = useState<Tab>(defaultTab || "goals");
  const setTab = useCallback((t: Tab) => { setTabRaw(t); onTabChange?.(t); }, [onTabChange]);

  // C4 (Tony's 2026-05-16): when the hamburger menu deep-links to a specific
  // sub-tab while BusinessView is already mounted (e.g. user on the goals tab
  // clicks "Master Task List"), useState's initial-value-only semantics mean
  // tab stays stale. Sync the internal tab whenever defaultTab changes.
  useEffect(() => {
    if (defaultTab && defaultTab !== tab) setTabRaw(defaultTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTab]);
  const [masterSubTab, setMasterSubTab] = useState<"tasks" | "linear">("tasks");
  const [pendingParentFilter, setPendingParentFilter] = useState<string | null>(null);
  // E1 (Tony's 2026-05-16): clicking a category in the 411 Goal Cascade
  // hands off to the master task list, pre-filtered to that category.
  const [pendingCategoryFilter, setPendingCategoryFilter] = useState<string | null>(null);
  // Survives the Ideas → Tasks tab switch so MasterTaskTab opens the
  // AddTaskModal with the right prefill on mount, no event-listener race.
  const [pendingTaskPrefill, setPendingTaskPrefill] = useState<Record<string, string> | null>(null);
  const [categories, setCategories] = useState<CategoryWithSubs[]>([]);
  const [byOwner, setByOwner] = useState<Record<string, Record<number, PlanItem[]>>>({});
  const [childStats, setChildStats] = useState<Record<string, { total: number; done: number }>>({});

  const handleWeeklyTaskClick = (task: PlanItem) => {
    setPendingParentFilter(task.id);
    setTab("tasks");
  };
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  type PlanTask = { id: string; title: string; category: string; subcategory?: string | null; owner?: string | null; priority?: string | null; sprintId?: string; status?: string | null; dueDate?: string | null; };
  const [top3, setTop3] = useState<PlanTask[]>([]);

  const loadTop3 = useCallback(async () => {
    try { const d: { tasks: PlanTask[] } = await get("/plan/top3"); setTop3(d.tasks || []); } catch { /**/ }
  }, []);

  const loadPlan = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await get("/plan/categories");
      setCategories((data as any).categories || []);
    } catch { if (!silent) setErr("Failed to load 411 plan"); }
    finally { if (!silent) setLoading(false); }
  }, []);

  const loadWeekly = useCallback(async () => {
    try {
      const data:any = await get("/plan/weekly/2026-04");
      setByOwner(data.byOwner || {});
      setChildStats(data.childStats || {});
    } catch { /**/ }
  }, []);

  useEffect(() => { loadPlan(); loadWeekly(); loadTop3(); }, [loadPlan, loadWeekly, loadTop3]);

  async function handleToggleTask(id: string, complete: boolean) {
    // Optimistic UI update — instant visual feedback
    const updateItem = (item: PlanItem): PlanItem =>
      item.id === id ? { ...item, status: complete ? "completed" : "active", completedAt: complete ? new Date().toISOString() : null } : item;

    setCategories(prev => prev.map(cat => ({
      ...cat,
      completedTasks: cat.completedTasks + (cat.subcategories.some(s => s.tasks.some(t => t.id === id)) ? (complete ? 1 : -1) : 0),
      subcategories: cat.subcategories.map(sub => ({
        ...sub,
        completedTasks: sub.completedTasks + (sub.tasks.some(t => t.id === id) ? (complete ? 1 : -1) : 0),
        tasks: sub.tasks.map(updateItem),
      })),
    })));
    setByOwner(prev => {
      const next = { ...prev };
      for (const owner of Object.keys(next)) {
        next[owner] = { ...next[owner] };
        for (const week of Object.keys(next[owner])) {
          next[owner][Number(week)] = next[owner][Number(week)].map(updateItem);
        }
      }
      return next;
    });

    loadTop3();
    try {
      if (complete) await post(`/plan/task/${id}/complete`, {});
      else await post(`/plan/task/${id}/uncomplete`, {});
      await Promise.all([loadPlan(true), loadWeekly()]);
    } catch (e: any) {
      // Revert on failure
      await Promise.all([loadPlan(true), loadWeekly()]);
      if (e.message?.includes("remaining")) setToast(e.message);
    }
  }

  async function handlePushToSheet() {
    setSyncing(true);
    try { await post("/business/push-to-sheet", {}); setToast("✓ Pushed to Google Sheet"); } catch { setErr("Push to Sheet failed"); }
    finally { setSyncing(false); }
  }

  const totalTasks = categories.reduce((s, c) => s + c.totalTasks, 0);
  const doneTasks = categories.reduce((s, c) => s + c.completedTasks, 0);

  const tabStyle = (active: boolean): CSSProperties => ({
    padding: "7px 14px", borderRadius: 8, border: "none", fontSize: 12,
    fontWeight: active ? 700 : 500, cursor: "pointer", fontFamily: F,
    background: active ? "#F97316" : C.card, color: active ? "#fff" : C.sub,
    transition: "all 0.15s",
  });

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F }}>
      {/* Header */}
      <div style={{ position: "static", top: 0, zIndex: 50, background: C.bg, borderBottom: `1px solid ${C.brd}`, padding: "0 32px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto", paddingTop: 18, paddingBottom: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <button onClick={onBack} style={{ background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 13, fontFamily: F }}>← Back</button>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.tx }}>Business Brain</div>
                <div style={{ fontSize: 11, color: C.sub }}>
                  {tab === "goals" && `411 Goal Cascade — ${doneTasks}/${totalTasks} tasks · ${totalTasks > 0 ? Math.round(doneTasks/totalTasks*100) : 0}% complete`}
                  {tab === "team" && "Team roster — scope, accountability, gaps"}
                  {tab === "tasks" && "Master task list — drag to reorder · sprint ID format"}
                  {tab === "ideas" && "Ideas parking lot — review, edit, convert to tasks, delete"}
                  {tab === "plan" && "Business plan + 90-day OAP narrative"}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, position: "relative" }}>
              {tab === "goals" && (
                <button onClick={handlePushToSheet} disabled={syncing} style={{ padding: "6px 12px", borderRadius: 7, border: `1px solid ${C.grn}`, background: C.grnBg, color: C.grn, fontSize: 12, cursor: "pointer", fontFamily: F }}>↑ Push</button>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 4, paddingBottom: 14 }}>
            <button style={tabStyle(tab === "goals")} onClick={() => setTab("goals")}>🎯 411 plan</button>
            <button style={tabStyle(tab === "team")} onClick={() => setTab("team")}>👥 Team roster</button>
            <button style={tabStyle(tab === "tasks")} onClick={() => setTab("tasks")}>✅ Master task</button>
            <button style={tabStyle(tab === "ideas")} onClick={() => setTab("ideas")}>💡 Ideas</button>
            <button style={tabStyle(tab === "plan")} onClick={() => setTab("plan")}>📄 Business plan</button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: tab === "tasks" ? "none" : 1000, margin: "0 auto", padding: tab === "tasks" ? "0 16px 24px" : "24px 32px" }}>
        {err && (
          <div style={{ background: C.redBg, border: `1px solid ${C.red}`, borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 16, display: "flex", justifyContent: "space-between" }}>
            {err}<button onClick={() => setErr(null)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer" }}>✕</button>
          </div>
        )}

        {tab === "goals" && (
          <>
            <GPSCards />
            {loading ? (
              <div style={{ textAlign: "center", padding: "48px", color: C.mut }}>Loading 411 plan…</div>
            ) : (
              <>
                <CategoryGrid
                  categories={categories}
                  onToggleTask={handleToggleTask}
                  onCategoryClick={(catKey) => {
                    // E1: jump to master task list filtered to this category.
                    setPendingCategoryFilter(catKey);
                    setMasterSubTab("tasks");
                    setTab("tasks");
                  }}
                />
                <WeeklyGrid byOwner={byOwner} childStats={childStats} onToggleTask={handleToggleTask} onTaskClick={handleWeeklyTaskClick} />
              </>
            )}
          </>
        )}

        {tab === "team" && <TeamTab />}
        {tab === "tasks" && (
          <>
            <MasterSubTabBar value={masterSubTab} onChange={setMasterSubTab} />
            {masterSubTab === "tasks" && (
              <MasterTaskTab
                // C3 (Tony's 2026-05-16): task edits must propagate to ALL views
                // that read the same data — 411 cascade (loadPlan), weekly
                // (loadWeekly), and the Top 3 panel (loadTop3). Previously
                // loadTop3 was only fetched on mount, so a renamed task kept
                // its old title in the Top 3 card here until full reload.
                onRefreshAll={() => { loadPlan(true); loadWeekly(); loadTop3(); }}
                categories={categories}
                initialParentFilter={pendingParentFilter}
                onInitialParentFilterConsumed={() => setPendingParentFilter(null)}
                initialPrefill={pendingTaskPrefill}
                onInitialPrefillConsumed={() => setPendingTaskPrefill(null)}
                initialCategoryFilter={pendingCategoryFilter}
                onInitialCategoryFilterConsumed={() => setPendingCategoryFilter(null)}
              />
            )}
            {masterSubTab === "linear" && <LinearPrioritiesTable />}
          </>
        )}
        {tab === "ideas" && (
          <IdeasView
            ideas={[]}
            onIdeasChange={() => { /* IdeasView fetches its own list */ }}
            onCreateTask={(ideaText, category, urgency, techType) => {
              // INSTANT tab switch + modal open. The previous version
              // awaited the AI generate-task call (5-10s) before switching
              // tabs — Tony saw "nothing happening" and would manually switch,
              // which is exactly when the modal would finally pop up. Now
              // we open the modal immediately with computed fallback fields
              // and fire the AI enhancement in the background; if the AI
              // returns better fields, we upgrade the prefill via the
              // existing tcc:prefill-task event so AddTaskModal can refresh.
              const fallback = {
                title: ideaText.slice(0, 120),
                category: (category || "tech").toLowerCase(),
                owner: "Tony",
                priority: urgency === "Now" ? "P0" : urgency === "This Week" ? "P1" : "P2",
                source: "TCC",
                workNotes: ideaText,
              };
              setPendingTaskPrefill(fallback);
              setTab("tasks");
              // Background AI upgrade — fire-and-forget; non-blocking.
              post<{ ok: boolean; taskFields?: any }>("/ideas/generate-task", {
                ideaText, category, urgency, techType,
              }).then(res => {
                if (res?.ok && res.taskFields) {
                  // Dispatch the legacy event so any open AddTaskModal can
                  // pick up the AI-enhanced fields (only effective if user
                  // hasn't started editing yet — safe for the common case).
                  window.dispatchEvent(new CustomEvent("tcc:prefill-task", { detail: res.taskFields }));
                }
              }).catch(() => { /* AI failed — fallback already in place */ });
            }}
            onNavigate={() => { /* unused — sidebar handles nav */ }}
          />
        )}
        {tab === "plan" && <BusinessPlanTab />}
      </div>

      {toast && <Toast msg={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

export default BusinessView;
