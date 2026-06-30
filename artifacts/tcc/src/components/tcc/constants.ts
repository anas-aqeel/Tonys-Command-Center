export const F = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
export const FS = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
export const C = {
  bg: "#F9FAFB", card: "#FFFFFF", brd: "#E5E7EB", tx: "#1A1A1A",
  sub: "#4B5563", mut: "#9CA3AF", red: "#C62828", grn: "#2E7D32",
  amb: "#E65100", blu: "#1565C0", redBg: "#FEF2F2", grnBg: "#ECFDF5",
  ambBg: "#FFF3EB", bluBg: "#EFF6FF",
};
export const SC: Record<string, string> = { Hot: C.red, Warm: C.amb, New: C.blu, Cold: C.mut };

export const PIPELINE_STAGES = ["Lead", "Qualified", "Demo Scheduled", "Proposal Sent", "Negotiation", "Closed Won", "Closed Lost"] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];
export const PC: Record<string, string> = {
  "Lead": "#607D8B",
  "Qualified": C.blu,
  "Demo Scheduled": "#7B1FA2",
  "Proposal Sent": C.amb,
  "Negotiation": "#E65100",
  "Closed Won": C.grn,
  "Closed Lost": C.mut,
};
export const PCBg: Record<string, string> = {
  "Lead": "#ECEFF1",
  "Qualified": C.bluBg,
  "Demo Scheduled": "#F3E5F5",
  "Proposal Sent": C.ambBg,
  "Negotiation": "#FBE9E7",
  "Closed Won": C.grnBg,
  "Closed Lost": "#F5F5F5",
};

export const LEAD_SOURCES = ["LinkedIn", "Referral", "Cold Outreach", "Event", "Website", "Partner", "Other"] as const;
export const STATUS_OPTIONS = ["Hot", "Warm", "New", "Cold"] as const;
export const CONTACT_TYPES = ["OPERATOR-INVESTOR", "Institutional Investor", "Investor", "Broker/Investor", "Wholesaler", "Lender/Affiliate", "Agent", "Other"] as const;
export const CONTACT_CATEGORIES = [
  "A — Priority Pipeline",
  "C — Institutional Investor",
  "D — Broker-Investor",
  "E — Wholesaler/Team",
  "F — Independent Investor",
  "G — Lender/HML",
  "H — REI Club/Network",
  "H — Agent/Realtor",
  "I — Coach/Influencer",
] as const;

export const TIPS: Record<string, string> = {
  checkin: "Morning gate. System locked until done. Bedtime, wake, Bible, workout, journal, nutrition, unplug. Saved to database.",
  journal: "Brain dump. Auto-formats: Mood, Key Events, Reflection. Saved to database.",
  ideas: "Capture ideas. Auto-prioritizes against business plan. Tech → Slack notification.",
  gmail: "Important Emails with reply/snooze/train. FYI (no reply). Badge shows unresolved.",
  snooze: "Removes email until chosen time. Restored from DB on next load.",
  suggestReply: "AI drafts reply in your voice. You approve and copy.",
  attempt: "Log call attempt. Give follow-up instructions. AI drafts email.",
  connected: "Log outcome, notes, next step, follow-up.",
  eod: "Generate EOD report and send to configured recipients.",
  chat: "Open AI chat for any question or request.",
};

export const TODAY_STR = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  const diff = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff} days ago`;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

import type React from "react";
export const card: React.CSSProperties = { background: C.card, borderRadius: 12, padding: "20px 24px", border: `1px solid ${C.brd}` };
export const inp: React.CSSProperties = { width: "100%", padding: "10px 14px", borderRadius: 8, border: `1px solid ${C.brd}`, fontSize: 14, fontFamily: F, boxSizing: "border-box", outline: "none" };
export const btn1: React.CSSProperties = { padding: "14px 28px", background: "#F97316", color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: F };
export const btn2: React.CSSProperties = { padding: "10px 18px", background: C.card, color: C.tx, border: `1px solid ${C.brd}`, borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: F };
export const lbl: React.CSSProperties = { display: "block", fontSize: 10, fontWeight: 600, color: C.mut, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 };

export const BRAND = { name: "Command Brain", tagline: "Tony's AI Operating System" };
