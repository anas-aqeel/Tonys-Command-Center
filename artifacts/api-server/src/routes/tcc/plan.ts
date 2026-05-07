import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { planItemsTable, brainTrainingLogTable, businessContextTable, teamRolesTable } from "../../lib/schema-v2";
import { BUSINESS_CONTEXT_DEFAULTS } from "../../lib/business-context-defaults";
import { eq, and, asc, desc, inArray } from "drizzle-orm";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { syncTasksTab } from "./sheets-sync";
import { postSlackMessage, listSlackUsers, notifyAssigneeViaSlack } from "../../lib/slack";
import { getLinearMembers } from "../../lib/linear";
import { recordFeedback } from "../../agents/feedback.js";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";

const router: IRouter = Router();

// Helper: trigger Google Sheets sync after task mutations (fire-and-forget)
// DISABLED — unidirectional push overwrote Tony's Sheet. Webhook-based bidirectional
// sync will replace this. `syncTasksTab` is still importable and callable manually.
function triggerSheetsSync() { /* no-op — see webhook migration */ }
// Keep the import usage silenced for the linter; remove-once webhook lands.
void syncTasksTab;

// ─── Types ──────────────────────────────────────────────────────────────────

type PlanItem = typeof planItemsTable.$inferSelect;

// ─── Sprint ID helper ─────────────────────────────────────────────────────────

const CAT_PREFIX: Record<string, string> = {
  goals:      "GLS",
  adaptation: "ADP",
  sales:      "SLS",
  tech:       "TCH",
  capital:    "CAP",
  team:       "TME",
};

function assignSprintIds(tasks: PlanItem[]): (PlanItem & { sprintId: string })[] {
  // Group by category, sort by priorityOrder within each
  const byCategory: Record<string, PlanItem[]> = {};
  for (const t of tasks) {
    const cat = t.category || "misc";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(t);
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].sort((a, b) => (a.priorityOrder ?? 999) - (b.priorityOrder ?? 999));
  }
  return tasks.map(t => {
    const cat = t.category || "misc";
    const idx = (byCategory[cat] || []).findIndex(x => x.id === t.id);
    const prefix = CAT_PREFIX[cat] || cat.slice(0, 3).toUpperCase();
    const sprintId = `${prefix}-${String(idx + 1).padStart(2, "0")}`;
    return { ...t, sprintId };
  });
}

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, High: 1, Low: 3 };

// ─── Seed Data ────────────────────────────────────────────────────────────────

const SEED_CATEGORIES = [
  { category: "adaptation", title: "01 Adaptation", priorityOrder: 1 },
  { category: "sales",      title: "02 Sales",      priorityOrder: 2 },
  { category: "tech",       title: "03 Tech",        priorityOrder: 3 },
  { category: "capital",    title: "04 Capital",     priorityOrder: 4 },
  { category: "team",       title: "05 Team",        priorityOrder: 5 },
];

const SEED_SUBCATEGORIES: { category: string; title: string; priorityOrder: number }[] = [
  { category: "adaptation", title: "Operator Assessment",    priorityOrder: 1 },
  { category: "adaptation", title: "CS Dashboard",           priorityOrder: 2 },
  { category: "adaptation", title: "User Outreach",          priorityOrder: 3 },
  { category: "adaptation", title: "Success Playbook",       priorityOrder: 4 },
  { category: "adaptation", title: "Dead Weight Suspension", priorityOrder: 5 },

  { category: "sales", title: "Pricing & Approach",    priorityOrder: 1 },
  { category: "sales", title: "Commitments Pipeline",  priorityOrder: 2 },
  { category: "sales", title: "Demo Workflow",          priorityOrder: 3 },
  { category: "sales", title: "Sales Materials",        priorityOrder: 4 },
  { category: "sales", title: "Prospect Pipeline",      priorityOrder: 5 },

  { category: "tech", title: "CS Dashboard (Tech)",     priorityOrder: 1 },
  { category: "tech", title: "Foundation + DispoPro",   priorityOrder: 2 },
  { category: "tech", title: "AWS/Cloud Credits",       priorityOrder: 3 },
  { category: "tech", title: "AAA Build",               priorityOrder: 4 },
  { category: "tech", title: "USale Marketplace",       priorityOrder: 5 },

  { category: "capital", title: "Loan Direction Decision", priorityOrder: 1 },
  { category: "capital", title: "P&L / Financial Plan",   priorityOrder: 2 },
  { category: "capital", title: "Investor Meetings",       priorityOrder: 3 },
  { category: "capital", title: "Kiavi Broker",            priorityOrder: 4 },
  { category: "capital", title: "Nema/Lightning Docs",     priorityOrder: 5 },

  { category: "team", title: "PM/Engineer Hire",       priorityOrder: 1 },
  { category: "team", title: "Onboarding Manager",     priorityOrder: 2 },
  { category: "team", title: "Adaptation Manager",     priorityOrder: 3 },
  { category: "team", title: "Nate Transition",        priorityOrder: 4 },
  { category: "team", title: "SOW Updates",            priorityOrder: 5 },
];

const SEED_TASKS: {
  category: string; subcategory: string; title: string; owner: string;
  priority: string; dueDate: string; weekNumber: number; month: string;
  atomicKpi?: string; source?: string; executionTier?: string;
}[] = [
  // Operator Assessment (5 tasks)
  { category:"adaptation", subcategory:"Operator Assessment", title:"Tony: assess DBTM operator status", owner:"Tony", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Identify non-performing operators before they drain AA time", source:"OAP", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"Operator Assessment", title:"Tony: assess Hegemark status", owner:"Tony", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Identify non-performing operators", source:"OAP", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"Operator Assessment", title:"Tony: assess STJ/Sergio status", owner:"Tony", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Identify non-performing operators", source:"OAP", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"Operator Assessment", title:"Tony: assess Acquire'd status", owner:"Tony", priority:"P0", dueDate:"2026-04-14", weekNumber:2, month:"2026-04", atomicKpi:"Identify non-performing operators", source:"OAP", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"Operator Assessment", title:"Tony: assess remaining operators", owner:"Tony", priority:"P1", dueDate:"2026-04-17", weekNumber:2, month:"2026-04", atomicKpi:"Full operator health baseline", source:"OAP", executionTier:"Sprint" },

  // CS Dashboard (4 tasks)
  { category:"adaptation", subcategory:"CS Dashboard", title:"Ramy: build operator health dashboard", owner:"Ramy", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Visibility into AA activity per operator", source:"Linear", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"CS Dashboard", title:"Faisal: COO Dashboard MyStats tab", owner:"Faisal", priority:"P0", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Tony sees AAs closing per operator", source:"Linear", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"CS Dashboard", title:"Ramy: weekly status email to operators", owner:"Ramy", priority:"P1", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Operator accountability drives AA performance", source:"OAP", executionTier:"Maintenance" },
  { category:"adaptation", subcategory:"CS Dashboard", title:"Ethan: review dashboard KPIs with Tony", owner:"Ethan", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"Executive alignment on dashboard metrics", source:"TCC", executionTier:"Strategic" },

  // User Outreach (6 tasks)
  { category:"adaptation", subcategory:"User Outreach", title:"Ramy: contact all operators by Apr 17", owner:"Ramy", priority:"P0", dueDate:"2026-04-17", weekNumber:2, month:"2026-04", atomicKpi:"Every AA account contacted and activated", source:"OAP", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"User Outreach", title:"Ramy: classify operators active/struggling/dead", owner:"Ramy", priority:"P0", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Know which operators need intervention", source:"OAP", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"User Outreach", title:"Ramy: autotracker training for active operators", owner:"Ramy", priority:"P1", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"AAs using autotracker = faster deal flow", source:"OAP", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"User Outreach", title:"Ramy: 10DLC compliance check for all operators", owner:"Ramy", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"No compliance issues blocking AA outreach", source:"OAP", executionTier:"Maintenance" },
  { category:"adaptation", subcategory:"User Outreach", title:"Ramy: send weekly adaptation report to Ethan", owner:"Ramy", priority:"P1", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Ethan has visibility to enforce accountability", source:"TCC", executionTier:"Maintenance" },
  { category:"adaptation", subcategory:"User Outreach", title:"Ramy: OMS onboarding for new operators", owner:"Ramy", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Smooth onboarding = faster to first deal", source:"OAP", executionTier:"Sprint" },

  // Success Playbook (4 tasks)
  { category:"adaptation", subcategory:"Success Playbook", title:"Tony: define 'success' criteria for operators", owner:"Tony", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Clear bar for what 2 deals/month requires", source:"OAP", executionTier:"Strategic" },
  { category:"adaptation", subcategory:"Success Playbook", title:"Ramy: document OMS onboarding checklist", owner:"Ramy", priority:"P1", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"Repeatable onboarding = consistent AA quality", source:"OAP", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"Success Playbook", title:"Ramy: create adaptation milestone tracker", owner:"Ramy", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"Track which AAs are on path to 2 deals", source:"OAP", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"Success Playbook", title:"Ethan: publish success playbook v1", owner:"Ethan", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Scalable playbook for every operator", source:"TCC", executionTier:"Strategic" },

  // Dead Weight Suspension (4 tasks)
  { category:"adaptation", subcategory:"Dead Weight Suspension", title:"Tony: suspension criteria decision with Ethan", owner:"Tony", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Clear criteria protects platform quality", source:"OAP", executionTier:"Strategic" },
  { category:"adaptation", subcategory:"Dead Weight Suspension", title:"Ethan: implement suspension workflow in Linear", owner:"Ethan", priority:"P1", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"No bad operators dragging platform metrics", source:"Linear", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"Dead Weight Suspension", title:"Ramy: identify and flag dead weight operators", owner:"Ramy", priority:"P1", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"Remove dead weight to protect platform quality", source:"OAP", executionTier:"Sprint" },
  { category:"adaptation", subcategory:"Dead Weight Suspension", title:"Tony: execute first suspension wave", owner:"Tony", priority:"P1", dueDate:"2026-04-28", weekNumber:4, month:"2026-04", atomicKpi:"Remove operators not moving toward 2 deals", source:"OAP", executionTier:"Strategic" },

  // Sales: Pricing & Approach (4 tasks)
  { category:"sales", subcategory:"Pricing & Approach", title:"Tony: finalize subsidized pricing model ($10K)", owner:"Tony", priority:"P0", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Pricing drives AA onboarding velocity", source:"OAP", executionTier:"Strategic" },
  { category:"sales", subcategory:"Pricing & Approach", title:"Tony: update sales script with new pricing", owner:"Tony", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"AAs sold faster = more deals in pipeline", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Pricing & Approach", title:"Bondilyn: finalize USale seller direct script", owner:"Bondilyn", priority:"P1", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Better script = higher AA conversion rate", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Pricing & Approach", title:"Tony: review P&L impact of new pricing with Ethan", owner:"Tony", priority:"P1", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Pricing sustainable to $50K break-even", source:"TCC", executionTier:"Strategic" },

  // Sales: Commitments Pipeline (3 tasks)
  { category:"sales", subcategory:"Commitments Pipeline", title:"Tony: 10 outbound calls/day (Mon–Fri)", owner:"Tony", priority:"P0", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Volume drives pipeline = deals/month", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Commitments Pipeline", title:"Tony: track commitments pipeline in CRM", owner:"Tony", priority:"P0", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Committed AAs = predictable deal flow", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Commitments Pipeline", title:"Bondilyn: build outreach database for prospects", owner:"Bondilyn", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"More prospects = more AAs = more deals", source:"OAP", executionTier:"Sprint" },

  // Sales: Demo Workflow (3 tasks)
  { category:"sales", subcategory:"Demo Workflow", title:"Tony: complete 5 demos Week 2", owner:"Tony", priority:"P0", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Demos convert to AA onboarding", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Demo Workflow", title:"Bondilyn: create demo slide deck v2", owner:"Bondilyn", priority:"P1", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"Better demo = higher AA sign-up rate", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Demo Workflow", title:"Tony: record demo video for async prospects", owner:"Tony", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Scale demos without Tony's time", source:"OAP", executionTier:"Sprint" },

  // Sales: Sales Materials (4 tasks)
  { category:"sales", subcategory:"Sales Materials", title:"Bondilyn: USale sales deck v2", owner:"Bondilyn", priority:"P1", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Better materials = faster AA conversion", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Sales Materials", title:"Bondilyn: podcast/video script for AA recruiting", owner:"Bondilyn", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"Content drives inbound AA interest", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Sales Materials", title:"Bondilyn: affiliate playbook v1", owner:"Bondilyn", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Affiliates scale AA recruiting beyond Tony", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Sales Materials", title:"Tony: review all materials with Bondilyn", owner:"Tony", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"Quality materials drive deal velocity", source:"TCC", executionTier:"Strategic" },

  // Sales: Prospect Pipeline (4 tasks)
  { category:"sales", subcategory:"Prospect Pipeline", title:"Bondilyn: build Wealthwise/KW prospect list", owner:"Bondilyn", priority:"P1", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Qualified prospects = faster AA pipeline", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Prospect Pipeline", title:"Tony: Kiavi broker app SIGNED", owner:"Tony", priority:"P0", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Kiavi broker = capital access for operators", source:"OAP", executionTier:"Strategic" },
  { category:"sales", subcategory:"Prospect Pipeline", title:"Tony: 3 new operator demos booked", owner:"Tony", priority:"P0", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"More demos = more AAs", source:"OAP", executionTier:"Sprint" },
  { category:"sales", subcategory:"Prospect Pipeline", title:"Tony: close 1 new operator", owner:"Tony", priority:"P0", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"New operator = new AAs = more deals", source:"OAP", executionTier:"Sprint" },

  // Tech: CS Dashboard Tech (4 tasks)
  { category:"tech", subcategory:"CS Dashboard (Tech)", title:"Faisal: MyStats tab — completion sprint", owner:"Faisal", priority:"P0", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Tony sees AA deal velocity per operator", source:"Linear", executionTier:"Sprint" },
  { category:"tech", subcategory:"CS Dashboard (Tech)", title:"Faisal: Template Health tab QA", owner:"Faisal", priority:"P0", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Template health = AA outreach quality", source:"Linear", executionTier:"Sprint" },
  { category:"tech", subcategory:"CS Dashboard (Tech)", title:"Faisal: SMS compliance UI feature registration", owner:"Faisal", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"10DLC compliance enables AA texting", source:"Linear", executionTier:"Sprint" },
  { category:"tech", subcategory:"CS Dashboard (Tech)", title:"Ethan: Linear review — CS Dashboard sprint", owner:"Ethan", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"Sprint delivery = tools for AAs faster", source:"Linear", executionTier:"Maintenance" },

  // Tech: Foundation + DispoPro (4 tasks)
  { category:"tech", subcategory:"Foundation + DispoPro", title:"Haris: agent pipeline MLS sync stability", owner:"Haris", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Reliable MLS data = AAs find deals faster", source:"Linear", executionTier:"Sprint" },
  { category:"tech", subcategory:"Foundation + DispoPro", title:"Haris: DispoPro integration milestone 1", owner:"Haris", priority:"P0", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Dispo access = AAs close deals faster", source:"Linear", executionTier:"Sprint" },
  { category:"tech", subcategory:"Foundation + DispoPro", title:"Haris: agent contact matching (close 15% gap)", owner:"Haris", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"Better contact matching = more AA leads", source:"Linear", executionTier:"Sprint" },
  { category:"tech", subcategory:"Foundation + DispoPro", title:"Haris: cross-platform infrastructure audit", owner:"Haris", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Stable infra = reliable AA tools", source:"Linear", executionTier:"Maintenance" },

  // Tech: AWS/Cloud Credits (3 tasks)
  { category:"tech", subcategory:"AWS/Cloud Credits", title:"Nate: AWS cost reduction plan", owner:"Nate", priority:"P0", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Lower AWS cost extends runway to break-even", source:"TCC", executionTier:"Strategic" },
  { category:"tech", subcategory:"AWS/Cloud Credits", title:"Nate: Google Cloud migration architecture review", owner:"Nate", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"Cloud migration reduces infra costs", source:"TCC", executionTier:"Strategic" },
  { category:"tech", subcategory:"AWS/Cloud Credits", title:"Ethan: confirm AWS credit application", owner:"Ethan", priority:"P1", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"AWS credits extend runway", source:"TCC", executionTier:"Strategic" },

  // Tech: AAA Build (4 tasks)
  { category:"tech", subcategory:"AAA Build", title:"Nate: AAA architecture spec (PM knowledge transfer)", owner:"Nate", priority:"P0", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"AAA automates AA outreach = more deals/month", source:"OAP", executionTier:"Strategic" },
  { category:"tech", subcategory:"AAA Build", title:"TBD PM: AAA Linear sprint setup", owner:"TBD PM", priority:"P1", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"AAA = scale AA deals without adding headcount", source:"OAP", executionTier:"Sprint" },
  { category:"tech", subcategory:"AAA Build", title:"Tony: AAA requirements spec", owner:"Tony", priority:"P0", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"Clear spec = faster AAA build", source:"OAP", executionTier:"Strategic" },
  { category:"tech", subcategory:"AAA Build", title:"Ethan: AAA budget approval", owner:"Ethan", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"Budget approved = AAA starts faster", source:"TCC", executionTier:"Strategic" },

  // Tech: USale Marketplace (4 tasks)
  { category:"tech", subcategory:"USale Marketplace", title:"Tony: USale Marketplace feature spec", owner:"Tony", priority:"P1", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Marketplace = scale beyond 375 operators", source:"OAP", executionTier:"Strategic" },
  { category:"tech", subcategory:"USale Marketplace", title:"Nate: marketplace architecture review", owner:"Nate", priority:"P1", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Solid architecture = faster marketplace launch", source:"TCC", executionTier:"Strategic" },
  { category:"tech", subcategory:"USale Marketplace", title:"Haris: marketplace data layer design", owner:"Haris", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Data foundation for marketplace scale", source:"Linear", executionTier:"Sprint" },
  { category:"tech", subcategory:"USale Marketplace", title:"Ethan: marketplace go-to-market with Tony", owner:"Ethan", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"GTM plan ensures marketplace drives deals", source:"TCC", executionTier:"Strategic" },

  // Capital: Loan Direction Decision (3 tasks)
  { category:"capital", subcategory:"Loan Direction Decision", title:"Tony: decide bridge vs growth loan path", owner:"Tony", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Capital decision enables path to $50K break-even", source:"OAP", executionTier:"Strategic" },
  { category:"capital", subcategory:"Loan Direction Decision", title:"Ethan: model loan scenarios for Tony", owner:"Ethan", priority:"P0", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Informed capital decision = lower financial risk", source:"TCC", executionTier:"Strategic" },
  { category:"capital", subcategory:"Loan Direction Decision", title:"Tony: capital decision confirmed with Ethan", owner:"Tony", priority:"P0", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Resolved capital direction = execution clarity", source:"OAP", executionTier:"Strategic" },

  // Capital: P&L / Financial Plan (4 tasks)
  { category:"capital", subcategory:"P&L / Financial Plan", title:"Ethan: April P&L review with Tony", owner:"Ethan", priority:"P0", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"P&L clarity drives revenue-first decisions", source:"TCC", executionTier:"Strategic" },
  { category:"capital", subcategory:"P&L / Financial Plan", title:"Ethan: DBTM revenue tracking setup", owner:"Ethan", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Track DBTM acq revenue (2/week but $0 in P&L)", source:"TCC", executionTier:"Maintenance" },
  { category:"capital", subcategory:"P&L / Financial Plan", title:"Ethan: monthly burn rate report", owner:"Ethan", priority:"P1", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Know burn vs revenue to hit break-even faster", source:"TCC", executionTier:"Maintenance" },
  { category:"capital", subcategory:"P&L / Financial Plan", title:"Ethan: Q2 financial model update", owner:"Ethan", priority:"P1", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Q2 model guides capital deployment", source:"TCC", executionTier:"Strategic" },

  // Capital: Investor Meetings (4 tasks)
  { category:"capital", subcategory:"Investor Meetings", title:"Tony: Chris Wesser — legal/capital raise update", owner:"Tony", priority:"P1", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Investor capital extends runway to scale", source:"TCC", executionTier:"Strategic" },
  { category:"capital", subcategory:"Investor Meetings", title:"Ethan: investor update report draft", owner:"Ethan", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"Regular updates = investor confidence", source:"TCC", executionTier:"Strategic" },
  { category:"capital", subcategory:"Investor Meetings", title:"Tony: 2 investor meetings booked", owner:"Tony", priority:"P1", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Investor meetings = capital pipeline", source:"OAP", executionTier:"Strategic" },
  { category:"capital", subcategory:"Investor Meetings", title:"Tony: investor pitch deck update", owner:"Tony", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Better deck = higher investor conversion", source:"OAP", executionTier:"Strategic" },

  // Capital: Kiavi Broker (3 tasks)
  { category:"capital", subcategory:"Kiavi Broker", title:"Tony: start Kiavi broker application", owner:"Tony", priority:"P0", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Kiavi broker = revenue from loan brokerage", source:"OAP", executionTier:"Strategic" },
  { category:"capital", subcategory:"Kiavi Broker", title:"Tony: Kiavi broker agreement SIGNED", owner:"Tony", priority:"P0", dueDate:"2026-04-18", weekNumber:2, month:"2026-04", atomicKpi:"Signed agreement = loan brokerage revenue stream", source:"OAP", executionTier:"Strategic" },
  { category:"capital", subcategory:"Kiavi Broker", title:"Tony: first Kiavi deal submitted", owner:"Tony", priority:"P1", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"First deal = proof of broker revenue model", source:"OAP", executionTier:"Strategic" },

  // Capital: Nema/Lightning Docs (3 tasks)
  { category:"capital", subcategory:"Nema/Lightning Docs", title:"Tony: Nema partnership decision", owner:"Tony", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Nema = additional revenue per deal closed", source:"OAP", executionTier:"Strategic" },
  { category:"capital", subcategory:"Nema/Lightning Docs", title:"Chris Wesser: Lightning Docs legal review", owner:"Chris", priority:"P1", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"Legal cleared = revenue from Lightning Docs", source:"TCC", executionTier:"Strategic" },
  { category:"capital", subcategory:"Nema/Lightning Docs", title:"Ethan: model Nema revenue impact on P&L", owner:"Ethan", priority:"P1", dueDate:"2026-04-25", weekNumber:3, month:"2026-04", atomicKpi:"Nema revenue modeled = clear ROI", source:"TCC", executionTier:"Strategic" },

  // Team: PM/Engineer Hire (4 tasks)
  { category:"team", subcategory:"PM/Engineer Hire", title:"Ethan: PM/Engineer job spec finalized", owner:"Ethan", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"PM hire frees Tony 20-30% of sales time", source:"TCC", executionTier:"Strategic" },
  { category:"team", subcategory:"PM/Engineer Hire", title:"Ethan: PM/Engineer candidates sourced (3+)", owner:"Ethan", priority:"P0", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"PM removes Tony from engineering overhead", source:"TCC", executionTier:"Strategic" },
  { category:"team", subcategory:"PM/Engineer Hire", title:"Tony: PM/Engineer interviews (final round)", owner:"Tony", priority:"P0", dueDate:"2026-04-28", weekNumber:4, month:"2026-04", atomicKpi:"PM hired = AAA starts on time", source:"TCC", executionTier:"Strategic" },
  { category:"team", subcategory:"PM/Engineer Hire", title:"Ethan: PM offer letter sent", owner:"Ethan", priority:"P0", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"PM offer = engineering ownership transferred", source:"TCC", executionTier:"Strategic" },

  // Team: Onboarding Manager (3 tasks)
  { category:"team", subcategory:"Onboarding Manager", title:"Ethan: onboarding manager job spec", owner:"Ethan", priority:"P1", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"Onboarding manager = Ramy single-point risk eliminated", source:"TCC", executionTier:"Strategic" },
  { category:"team", subcategory:"Onboarding Manager", title:"Ethan: onboarding manager candidates sourced", owner:"Ethan", priority:"P1", dueDate:"2026-04-28", weekNumber:4, month:"2026-04", atomicKpi:"Dedicated onboarding = faster operator activation", source:"TCC", executionTier:"Strategic" },
  { category:"team", subcategory:"Onboarding Manager", title:"Tony: onboarding manager interview", owner:"Tony", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Hire = operaror onboarding scales without Ramy", source:"TCC", executionTier:"Strategic" },

  // Team: Adaptation Manager (3 tasks)
  { category:"team", subcategory:"Adaptation Manager", title:"Ethan: adaptation manager job spec", owner:"Ethan", priority:"P1", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"Adaptation manager = proactive churn prevention", source:"TCC", executionTier:"Strategic" },
  { category:"team", subcategory:"Adaptation Manager", title:"Ethan: adaptation manager candidates sourced", owner:"Ethan", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"Dedicated AM = AA feature adoption scales", source:"TCC", executionTier:"Strategic" },
  { category:"team", subcategory:"Adaptation Manager", title:"Tony: adaptation manager interview", owner:"Tony", priority:"P2", dueDate:"2026-04-30", weekNumber:4, month:"2026-04", atomicKpi:"AM hire = Ramy not single point of failure", source:"TCC", executionTier:"Strategic" },

  // Team: Nate Transition (4 tasks)
  { category:"team", subcategory:"Nate Transition", title:"Nate: foundation knowledge transfer to Haris", owner:"Nate", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Haris owns foundation = Nate at SLA only", source:"OAP", executionTier:"Strategic" },
  { category:"team", subcategory:"Nate Transition", title:"Nate: PM knowledge transfer plan", owner:"Nate", priority:"P0", dueDate:"2026-04-21", weekNumber:3, month:"2026-04", atomicKpi:"PM inherits Nate context = seamless transition", source:"OAP", executionTier:"Strategic" },
  { category:"team", subcategory:"Nate Transition", title:"Ethan: Nate SLA terms confirmed in writing", owner:"Ethan", priority:"P1", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"Written SLA = no open-ended Nate commitments", source:"OAP", executionTier:"Strategic" },
  { category:"team", subcategory:"Nate Transition", title:"Nate: 29 orphaned issues triaged with Ethan", owner:"Nate", priority:"P0", dueDate:"2026-04-14", weekNumber:1, month:"2026-04", atomicKpi:"No P0 issues orphaned = risk eliminated", source:"TCC", executionTier:"Sprint" },

  // Team: SOW Updates (3 tasks)
  { category:"team", subcategory:"SOW Updates", title:"Tony: review Ramy SOW with Ethan", owner:"Tony", priority:"P1", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Ramy SOW clarity = CS runs without Tony", source:"TCC", executionTier:"Strategic" },
  { category:"team", subcategory:"SOW Updates", title:"Ethan: weekly SOW accountability check (Fridays)", owner:"Ethan", priority:"P1", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Accountability = team delivers on deals per month", source:"TCC", executionTier:"Maintenance" },
  { category:"team", subcategory:"SOW Updates", title:"Ethan: Friday accountability report to Tony", owner:"Ethan", priority:"P1", dueDate:"2026-04-11", weekNumber:1, month:"2026-04", atomicKpi:"Tony knows team status without daily check-ins", source:"TCC", executionTier:"Maintenance" },
];

// ─── Seed function ────────────────────────────────────────────────────────────

async function seedPlanIfEmpty(): Promise<void> {
  const existing = await db.select({ id: planItemsTable.id })
    .from(planItemsTable).limit(1);
  if (existing.length > 0) return;

  const categoryRows = await db.insert(planItemsTable).values(
    SEED_CATEGORIES.map(c => ({
      level: "category" as const,
      category: c.category,
      title: c.title,
      priorityOrder: c.priorityOrder,
      status: "active",
    }))
  ).returning();

  const catByKey = Object.fromEntries(categoryRows.map(r => [r.category, r]));

  const subcatRows = await db.insert(planItemsTable).values(
    SEED_SUBCATEGORIES.map(s => ({
      level: "subcategory" as const,
      category: s.category,
      subcategory: s.title,
      title: s.title,
      parentId: catByKey[s.category]?.id,
      priorityOrder: s.priorityOrder,
      status: "active",
    }))
  ).returning();

  const subcatByKey = Object.fromEntries(
    subcatRows.map(r => [`${r.category}:${r.title}`, r])
  );

  await db.insert(planItemsTable).values(
    SEED_TASKS.map((t, i) => ({
      level: "task" as const,
      category: t.category,
      subcategory: t.subcategory,
      title: t.title,
      owner: t.owner,
      priority: t.priority,
      dueDate: t.dueDate,
      month: t.month,
      atomicKpi: t.atomicKpi,
      source: t.source,
      executionTier: t.executionTier,
      parentId: subcatByKey[`${t.category}:${t.subcategory}`]?.id,
      priorityOrder: i,
      status: "active",
    }))
  );

  console.log("[plan] Seeded plan_items: 5 categories, 25 subcategories, %d tasks", SEED_TASKS.length);
}

seedPlanIfEmpty().catch(e => console.warn("[plan] Seed failed:", e.message));

// ─── Parent completion check ──────────────────────────────────────────────────

async function checkParentCompletion(taskId: string): Promise<void> {
  const [task] = await db.select().from(planItemsTable).where(eq(planItemsTable.id, taskId));
  if (!task || task.level !== "task" || !task.parentId) return;

  const siblings = await db.select().from(planItemsTable)
    .where(and(eq(planItemsTable.parentId, task.parentId), eq(planItemsTable.level, "task")));
  const allDone = siblings.length > 0 && siblings.every(s => s.status === "completed");

  if (allDone) {
    await db.update(planItemsTable).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(planItemsTable.id, task.parentId));

    const [subcat] = await db.select().from(planItemsTable).where(eq(planItemsTable.id, task.parentId));
    if (subcat?.parentId) {
      const parentSiblings = await db.select().from(planItemsTable)
        .where(and(eq(planItemsTable.parentId, subcat.parentId), eq(planItemsTable.level, "subcategory")));
      const parentAllDone = parentSiblings.length > 0 && parentSiblings.every(s => s.status === "completed");
      if (parentAllDone) {
        await db.update(planItemsTable).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(planItemsTable.id, subcat.parentId));
      }
    }
  }
}

// ─── Linear sync helper ───────────────────────────────────────────────────────

async function syncLinearComplete(linearId: string, complete: boolean): Promise<void> {
  const key = process.env.LINEAR_API_KEY;
  if (!key || !linearId) return;

  // Get states for the issue's team, find completed state
  const statesResp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": key },
    body: JSON.stringify({
      query: `query { issue(id: "${linearId}") { team { states { nodes { id type } } } } }`
    })
  }).then(r => r.json()).catch(() => null);

  const states = statesResp?.data?.issue?.team?.states?.nodes || [];
  const targetType = complete ? "completed" : "started";
  const targetState = states.find((s: any) => s.type === targetType);
  if (!targetState) return;

  await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": key },
    body: JSON.stringify({
      query: `mutation { issueUpdate(id: "${linearId}", input: { stateId: "${targetState.id}" }) { success } }`
    })
  }).catch(() => null);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /plan/categories — full hierarchy for 411 plan view
router.get("/plan/categories", async (_req, res): Promise<void> => {
  try {
    const all = await db.select().from(planItemsTable).orderBy(asc(planItemsTable.priorityOrder), asc(planItemsTable.createdAt));
    const categories = all.filter(i => i.level === "category");
    const subcategories = all.filter(i => i.level === "subcategory");
    const tasks = all.filter(i => i.level === "task");

    const result = categories.map(cat => {
      const mySubs = subcategories.filter(s => s.parentId === cat.id);
      const myCatTasks = tasks.filter(t => {
        const sub = subcategories.find(s => s.id === t.parentId);
        return sub?.parentId === cat.id;
      });
      return {
        ...cat,
        subcategories: mySubs.map(sub => {
          const subTasks = tasks.filter(t => t.parentId === sub.id).sort((a, b) => (a.priorityOrder ?? 999) - (b.priorityOrder ?? 999));
          return {
            ...sub,
            tasks: subTasks,
            totalTasks: subTasks.length,
            completedTasks: subTasks.filter(t => t.status === "completed").length,
          };
        }),
        totalTasks: myCatTasks.length,
        completedTasks: myCatTasks.filter(t => t.status === "completed").length,
      };
    });

    res.json({ categories: result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /plan — alias
router.get("/plan", async (_req, res): Promise<void> => {
  try {
    const all = await db.select().from(planItemsTable).orderBy(asc(planItemsTable.priorityOrder), asc(planItemsTable.createdAt));
    res.json({ items: all });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /plan/weekly/:month — weekly grid data (week computed from dueDate, not stored)
router.get("/plan/weekly/:month", async (req, res): Promise<void> => {
  try {
    const { month } = req.params; // e.g. "2026-04"
    // Fetch ALL level=task rows — masters AND their children — so we can compute child stats
    const allTasks = await db.select().from(planItemsTable)
      .where(eq(planItemsTable.level, "task"))
      .orderBy(asc(planItemsTable.priorityOrder));

    // Child stats per master (total children + completed children), computed across all months
    const childStats: Record<string, { total: number; done: number }> = {};
    for (const t of allTasks) {
      if (t.parentTaskId && (t.taskType === "subtask" || t.taskType === "note")) {
        const s = childStats[t.parentTaskId] || { total: 0, done: 0 };
        s.total += 1;
        if (t.status === "completed") s.done += 1;
        childStats[t.parentTaskId] = s;
      }
    }

    // Bucket by (owner, computed week), filtering to the requested month
    const weekFromDue = (d: string | null): number | null => {
      if (!d) return null;
      const m = d.match(/^\d{4}-\d{2}-(\d{2})$/);
      if (!m) return null;
      const day = parseInt(m[1], 10);
      if (day <= 11) return 1;
      if (day <= 18) return 2;
      if (day <= 25) return 3;
      return 4;
    };

    const byOwner: Record<string, Record<number, PlanItem[]>> = {};
    for (const task of allTasks) {
      // Only masters render on the weekly grid; subs/notes stay in the Master Task list
      if ((task.taskType ?? "master") !== "master") continue;
      if (!task.dueDate) continue;
      if (!task.dueDate.startsWith(month)) continue;
      const week = weekFromDue(task.dueDate);
      if (!week) continue;
      const owner = task.owner || "Unassigned";
      if (!byOwner[owner]) byOwner[owner] = {};
      if (!byOwner[owner][week]) byOwner[owner][week] = [];
      byOwner[owner][week].push(task);
    }

    res.json({ month, byOwner, childStats });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /plan/tasks — flat task list with sprintIds for master table
router.get("/plan/tasks", async (req, res): Promise<void> => {
  try {
    const filters: any[] = [eq(planItemsTable.level, "task")];
    if (req.query.category) filters.push(eq(planItemsTable.category, req.query.category as string));
    if (req.query.owner) filters.push(eq(planItemsTable.owner, req.query.owner as string));
    if (req.query.status) filters.push(eq(planItemsTable.status, req.query.status as string));

    const tasks = await db.select().from(planItemsTable)
      .where(and(...filters))
      .orderBy(asc(planItemsTable.priorityOrder), asc(planItemsTable.category));

    const tasksWithSprintIds = assignSprintIds(tasks);

    res.json({ tasks: tasksWithSprintIds, total: tasks.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /plan/top3 — top 3 highest-priority active tasks across all categories
router.get("/plan/top3", async (_req, res): Promise<void> => {
  try {
    // Fetch ALL active tasks so sprint ID computation has full context
    const allActive = await db.select().from(planItemsTable)
      .where(and(eq(planItemsTable.level, "task"), eq(planItemsTable.status, "active")))
      .orderBy(asc(planItemsTable.priorityOrder));

    // Assign sprint IDs using full context
    const withSprintIds = assignSprintIds(allActive);

    // Pick top 3: P0 first (by priorityOrder within category), then P1 as fallback
    const p0 = withSprintIds.filter(t => t.priority === "P0");
    const p1 = withSprintIds.filter(t => t.priority === "P1");
    const top3 = [...p0, ...p1].slice(0, 3);

    res.json({ tasks: top3 });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /plan/subcategories/:category — return subcategory list for a category
router.get("/plan/subcategories/:category", async (req, res): Promise<void> => {
  try {
    const { category } = req.params;
    const subs = await db.select().from(planItemsTable)
      .where(and(eq(planItemsTable.level, "subcategory"), eq(planItemsTable.category, category)))
      .orderBy(asc(planItemsTable.priorityOrder));
    res.json({ subcategories: subs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /plan/task/:id/complete
router.post("/plan/task/:id/complete", async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const [item] = await db.select().from(planItemsTable).where(eq(planItemsTable.id, id));
    if (!item) { res.status(404).json({ error: "Not found" }); return; }

    if (item.level !== "task") {
      const subItems = await db.select().from(planItemsTable)
        .where(and(eq(planItemsTable.parentId, id), eq(planItemsTable.status, "active")));
      if (subItems.length > 0) {
        res.status(400).json({ error: `${subItems.length} ${item.level === "category" ? "subcategories" : "tasks"} remaining — complete all first` });
        return;
      }
    }

    const [updated] = await db.update(planItemsTable)
      .set({ status: "completed", completedAt: new Date(), completedBy: "Tony", updatedAt: new Date() })
      .where(eq(planItemsTable.id, id)).returning();

    if (item.level === "task") {
      await checkParentCompletion(id);
      // Sync to Linear if configured
      if (item.linearId) {
        syncLinearComplete(item.linearId, true).catch(e => console.warn("[plan] Linear sync failed:", e.message));
      }
    }

    triggerSheetsSync();
    res.json({ ok: true, item: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /plan/task/:id/uncomplete
router.post("/plan/task/:id/uncomplete", async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const [item] = await db.select().from(planItemsTable).where(eq(planItemsTable.id, id));
    if (!item) { res.status(404).json({ error: "Not found" }); return; }

    const [updated] = await db.update(planItemsTable)
      .set({ status: "active", completedAt: null, completedBy: null, updatedAt: new Date() })
      .where(eq(planItemsTable.id, id)).returning();

    if (updated.parentId) {
      await db.update(planItemsTable).set({ status: "active", completedAt: null, updatedAt: new Date() })
        .where(eq(planItemsTable.id, updated.parentId));
      const [parent] = await db.select().from(planItemsTable).where(eq(planItemsTable.id, updated.parentId));
      if (parent?.parentId) {
        await db.update(planItemsTable).set({ status: "active", completedAt: null, updatedAt: new Date() })
          .where(eq(planItemsTable.id, parent.parentId));
      }
    }

    // Sync to Linear
    if (item.linearId) {
      syncLinearComplete(item.linearId, false).catch(e => console.warn("[plan] Linear sync failed:", e.message));
    }

    triggerSheetsSync();
    res.json({ ok: true, item: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /plan/item/:id — update any plan item
router.patch("/plan/item/:id", async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const allowed = ["title","owner","coOwner","priority","dueDate","status","workNotes","atomicKpi","source","executionTier","linearId","subcategory"];
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const [updated] = await db.update(planItemsTable).set(updates).where(eq(planItemsTable.id, id)).returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    triggerSheetsSync();
    res.json({ ok: true, item: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /plan/task — create a new task with smart priority placement
router.post("/plan/task", async (req, res): Promise<void> => {
  try {
    const { category, subcategoryName, title, owner, coOwner, priority, dueDate, month, atomicKpi, source, executionTier, workNotes, linearId, taskType, parentTaskId, manualPosition, requiresLinearTicket, notifyOwnerSlack } = req.body;

    if (!category || !title) {
      res.status(400).json({ error: "category and title are required" });
      return;
    }

    const normalizedType: "master" | "subtask" | "note" =
      taskType === "subtask" || taskType === "note" ? taskType : "master";

    // Sub-tasks and notes must have a parent master
    if ((normalizedType === "subtask" || normalizedType === "note") && !parentTaskId) {
      res.status(400).json({ error: `${normalizedType} requires parentTaskId` });
      return;
    }
    if (parentTaskId) {
      const [parentRow] = await db.select().from(planItemsTable).where(eq(planItemsTable.id, parentTaskId));
      if (!parentRow || parentRow.level !== "task" || parentRow.taskType !== "master") {
        res.status(400).json({ error: "parentTaskId must reference an existing Master task" });
        return;
      }
    }

    // Find parent subcategory
    const [subcatRow] = await db.select().from(planItemsTable).where(and(
      eq(planItemsTable.level, "subcategory"),
      eq(planItemsTable.category, category),
      eq(planItemsTable.title, subcategoryName)
    ));

    // Find parent category
    const [catRow] = await db.select().from(planItemsTable).where(and(
      eq(planItemsTable.level, "category"),
      eq(planItemsTable.category, category)
    ));
    if (!catRow) { res.status(400).json({ error: "Category not found" }); return; }

    // Scope sibling tasks: masters among masters (in category), subs/notes among children of parentTaskId
    const siblingWhere = normalizedType === "master"
      ? and(eq(planItemsTable.level, "task"), eq(planItemsTable.category, category), eq(planItemsTable.taskType, "master"))
      : and(eq(planItemsTable.level, "task"), eq(planItemsTable.parentTaskId, parentTaskId));

    const existingTasks = await db.select().from(planItemsTable)
      .where(siblingWhere)
      .orderBy(asc(planItemsTable.priorityOrder));

    // Determine insertion position:
    // - If client sent `manualPosition` (user nudged ▲/▼ in preview panel), use it as the target index within siblings
    // - Otherwise fall back to priority-rank-based placement (notes always go to end)
    let insertOrder: number;
    if (typeof manualPosition === "number" && manualPosition >= 0) {
      insertOrder = Math.min(manualPosition, existingTasks.length);
    } else {
      const newRank = PRIORITY_RANK[priority] ?? 2;
      let insertAfterOrder = -1;
      if (normalizedType === "note") {
        insertAfterOrder = existingTasks.length > 0 ? (existingTasks[existingTasks.length - 1].priorityOrder ?? 0) : -1;
      } else {
        for (const t of existingTasks) {
          const tRank = PRIORITY_RANK[t.priority || "P2"] ?? 2;
          if (tRank <= newRank) insertAfterOrder = t.priorityOrder ?? 0;
        }
      }
      insertOrder = insertAfterOrder + 1;
    }

    // Shift all siblings at or after the insertion point up by 1
    for (const t of existingTasks) {
      if ((t.priorityOrder ?? 0) >= insertOrder) {
        await db.update(planItemsTable).set({ priorityOrder: (t.priorityOrder ?? 0) + 1 })
          .where(eq(planItemsTable.id, t.id));
      }
    }

    // Create the task
    const [created] = await db.insert(planItemsTable).values({
      level: "task" as const,
      category,
      subcategory: subcategoryName || null,
      title,
      owner: owner || null,
      coOwner: coOwner || null,
      priority: normalizedType === "note" ? null : (priority || "P2"),
      dueDate: normalizedType === "note" ? null : (dueDate || null),
      month: (dueDate && /^\d{4}-\d{2}/.test(dueDate)) ? dueDate.slice(0, 7) : (month || "2026-04"),
      atomicKpi: atomicKpi || null,
      source: source || "manual",
      executionTier: executionTier || "Sprint",
      workNotes: workNotes || null,
      linearId: linearId || null,
      parentId: subcatRow?.id || catRow.id,
      priorityOrder: insertOrder,
      status: normalizedType === "note" ? null : "active",
      taskType: normalizedType,
      parentTaskId: normalizedType === "master" ? null : parentTaskId,
    }).returning();

    // Re-normalize priority orders (make them sequential integers)
    const allTasksAfter = await db.select({ id: planItemsTable.id })
      .from(planItemsTable)
      .where(and(eq(planItemsTable.level, "task"), eq(planItemsTable.category, category)))
      .orderBy(asc(planItemsTable.priorityOrder));

    for (let i = 0; i < allTasksAfter.length; i++) {
      await db.update(planItemsTable).set({ priorityOrder: i })
        .where(eq(planItemsTable.id, allTasksAfter[i].id));
    }

    // Compute sprint position
    const taskIdx = allTasksAfter.findIndex(t => t.id === created.id);
    const prefix = CAT_PREFIX[category] || category.slice(0, 3).toUpperCase();
    const sprintId = `${prefix}-${String(taskIdx + 1).padStart(2, "0")}`;

    // Find neighbors
    const prevTask = taskIdx > 0 ? existingTasks[taskIdx - 1] : null;
    const nextTask = taskIdx < allTasksAfter.length - 1 ? existingTasks[taskIdx] : null;

    triggerSheetsSync();

    // Single Slack-notify path. Either the new `notifyOwnerSlack` flag or the
    // legacy `requiresLinearTicket` flag triggers exactly ONE DM to the owner.
    // The message body adapts: when the task is a Linear-source task without a
    // ticket ID, the DM asks the owner to create the matching Linear ticket;
    // otherwise it's a generic task-assigned notice. Self-assigns (owner=Tony)
    // are silently skipped — Tony doesn't need to be DM'd about his own tasks.
    let slackNotified: { ok: boolean; owner: string; slackId?: string; error?: string } | null = null;
    const shouldNotifyOwner = !!(
      (notifyOwnerSlack || requiresLinearTicket) &&
      owner &&
      typeof owner === "string" &&
      owner.trim() &&
      owner.trim().toLowerCase() !== "tony"
    );
    if (shouldNotifyOwner) {
      try {
        const [tm] = await db.select().from(teamRolesTable).where(eq(teamRolesTable.name, owner)).limit(1);
        if (tm?.slackId) {
          const isLinearCreate = source === "Linear" && !linearId;
          const dueLine = dueDate ? `\n*Due:* ${dueDate}` : "";
          const priorityLine = priority ? ` • *Priority:* ${priority}` : "";
          const notesLine = workNotes ? `\n*Notes:* ${workNotes}` : "";
          const text = isLinearCreate
            ? `🎯 *Tony assigned you a task — please create a Linear ticket*\n> ${title}\n*Category:* ${category}${priorityLine}${dueLine}${notesLine}\n\nOnce the Linear ticket is created, paste its ID into the task in TCC so both systems stay in sync.`
            : `🎯 *Tony assigned you a task*\n> ${title}\n*Category:* ${category}${priorityLine}${dueLine}${notesLine}`;
          const r = await postSlackMessage({ channel: tm.slackId, text });
          slackNotified = { ok: r.ok, owner, slackId: tm.slackId, error: r.error };
        } else {
          slackNotified = { ok: false, owner, error: "no_slack_id_on_team_roster" };
        }
      } catch (err) {
        slackNotified = { ok: false, owner, error: (err as Error).message };
      }
    }

    res.json({
      ok: true,
      task: { ...created, sprintId },
      sprintId,
      position: taskIdx + 1,
      total: allTasksAfter.length,
      prevTask: prevTask ? { title: prevTask.title, sprintId: `${prefix}-${String(taskIdx).padStart(2,"0")}` } : null,
      nextTask: nextTask ? { title: nextTask.title, sprintId: `${prefix}-${String(taskIdx + 2).padStart(2,"0")}` } : null,
      slackNotified,
    });
  } catch (err: any) {
    console.error("[plan] POST /plan/task error:", err);
    res.status(500).json({ error: err?.message || String(err), detail: err?.detail || err?.code || undefined });
  }
});

// POST /plan/reorder — bulk update priority orders (after drag-drop)
// Optionally accepts explanation + displacedIds to log training data and get AI reflection
router.post("/plan/reorder", async (req, res): Promise<void> => {
  try {
    const { items, explanation, movedItemId, movedItemTitle, fromPosition, toPosition, displacedItemIds, displacedItemTitles, direction } = req.body as {
      items: { id: string; priorityOrder: number }[];
      explanation?: string;
      movedItemId?: string;
      movedItemTitle?: string;
      fromPosition?: number;
      toPosition?: number;
      displacedItemIds?: string[];
      displacedItemTitles?: string[];
      direction?: "up" | "down";
    };
    if (!Array.isArray(items)) { res.status(400).json({ error: "items must be array" }); return; }

    for (const item of items) {
      await db.update(planItemsTable)
        .set({ priorityOrder: item.priorityOrder, updatedAt: new Date() })
        .where(eq(planItemsTable.id, item.id));
    }

    let aiReflection: string | null = null;
    let feedbackId: string | undefined;

    if (explanation?.trim() && movedItemId) {
      const movedDown = direction === "down";
      const displacedList = (displacedItemTitles || []).slice(0, 5).map((t, i) => `${i + 1}. ${t}`).join("\n");
      const directionLine = movedDown
        ? `Tony moved this task DOWN — meaning it is now LESS important than the tasks it was placed below.`
        : `Tony moved this task UP — meaning it is now MORE important than the tasks it leapfrogged over.`;
      const displacedLabel = movedDown ? "NOW RANKED ABOVE IT (more important):" : "LEAPFROGGED OVER (now less important):";
      const prompt = `You are Tony Diaz's AI sprint brain for FlipIQ. Tony just reordered a task and explained why.

TASK: "${movedItemTitle || "Unknown"}"
DIRECTION: ${directionLine}
${displacedLabel}
${displacedList || "(none listed)"}

TONY'S EXPLANATION: "${explanation}"

Write a concise 2-3 sentence reflection (under 80 words) that is relevant to the direction Tony moved the task. If moved DOWN (less important), acknowledge what is more urgent and why deprioritizing makes sense. If moved UP (more important), confirm the reasoning or note a tradeoff. Be direct — no fluff. Start with "Got it —" or similar.`;

      try {
        // Flag-gated: AGENT_RUNTIME_TASKS=true routes through runtime.
        if (isAgentRuntimeEnabled("tasks")) {
          const userMessage = `TASK: "${movedItemTitle || "Unknown"}"\nDIRECTION: ${directionLine}\n${displacedLabel}\n${displacedList || "(none listed)"}\n\nTONY'S EXPLANATION: "${explanation}"`;
          const result = await runAgent("tasks", "reorder-reflect", {
            userMessage,
            caller: "direct",
            meta: { movedItemId, direction },
          });
          aiReflection = result.text.trim();
        } else {
          const msg = await createTrackedMessage("plan_organize", {
            model: "claude-haiku-4-5",
            max_tokens: 200,
            messages: [{ role: "user", content: prompt }],
          });
          const block = msg.content[0];
          if (block.type === "text") aiReflection = block.text.trim();
        }
      } catch (e) {
        console.warn("[plan/reorder] Claude reflection failed:", e);
      }

      await db.insert(brainTrainingLogTable).values({
        movedItemId,
        movedItemTitle: movedItemTitle || null,
        fromPosition: fromPosition ?? null,
        toPosition: toPosition ?? null,
        displacedItemIds: displacedItemIds || [],
        displacedItemTitles: displacedItemTitles || [],
        tonyExplanation: explanation.trim(),
        aiReflection,
      });

      // New universal feedback capture — gives Coach access to Tony's reorder
      // explanation + AI reflection. Awaited so the FE Brain Training save
      // can fire a Train-now toast pointing at this exact row.
      try {
        const fb = await recordFeedback({
          agent: "tasks",
          skill: "ai-organize",
          sourceType: "reorder",
          sourceId: movedItemId,
          reviewText: explanation.trim(),
          snapshotExtra: {
            movedItemTitle,
            fromPosition,
            toPosition,
            direction,
            displacedItemTitles,
            aiReflection,
          },
        });
        feedbackId = fb.feedbackId;
      } catch (err) { console.error("[plan/reorder] recordFeedback failed:", err); }
    }

    res.json({ ok: true, updated: items.length, aiReflection, feedback_id: feedbackId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /plan/brain/order — ask Claude to re-rank active tasks.
// Query params:
//   mode=top50 (default) — re-rank only the top 50 by current priorityOrder; the
//     rest stay in their current positions. Stays under Vercel's 300s timeout
//     even with Sonnet output that's heavy in tokens.
//   mode=all — re-rank EVERY active task. May approach Vercel's 300s ceiling
//     for very large lists (~200+ tasks). Use for full periodic re-orgs.
router.get("/plan/brain/order", async (req, res): Promise<void> => {
  try {
    const mode = (req.query.mode === "all") ? "all" : "top50";
    const TOP_LIMIT = 50;

    const allActive = await db.select().from(planItemsTable)
      .where(and(eq(planItemsTable.level, "task"), eq(planItemsTable.status, "active")))
      .orderBy(asc(planItemsTable.priorityOrder));

    if (allActive.length === 0) {
      res.json({ priorityOrder: [], tasks: [], mode, organizedCount: 0, totalCount: 0 });
      return;
    }

    // The "tasks fed to the model" set. In top50 mode, only re-rank the top N;
    // the tail keeps its existing order and gets appended unchanged after merge.
    const activeTasks = mode === "all" ? allActive : allActive.slice(0, TOP_LIMIT);
    const tailTasks = mode === "all" ? [] : allActive.slice(TOP_LIMIT);

    const recentLogs = await db.select().from(brainTrainingLogTable)
      .orderBy(desc(brainTrainingLogTable.createdAt))
      .limit(20);

    let brainContext = "";
    try {
      const [ctx] = await db.select().from(businessContextTable)
        .where(eq(businessContextTable.documentType, "brain_context"));
      if (ctx?.content) brainContext = ctx.content;
    } catch { /**/ }

    let businessPlanCtx = "";
    try {
      const [bp] = await db.select().from(businessContextTable)
        .where(eq(businessContextTable.documentType, "business_plan"));
      if (bp?.content) businessPlanCtx = bp.content.substring(0, 3000);
    } catch { /**/ }

    const taskList = activeTasks.map((t, i) => {
      const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
      const prank = PRIORITY_RANK[t.priority || "P2"] ?? 2;
      const typeLabel = t.taskType === "subtask" ? "SUB" : t.taskType === "note" ? "NOTE" : "MASTER";
      const parentRef = t.parentTaskId ? ` | Parent:${t.parentTaskId}` : "";
      return `${i + 1}. [${t.id}] ${typeLabel} | ${t.category}/${t.subcategory || "—"} | "${t.title}" | Owner:${t.owner || "?"} | Priority:${t.priority || "?"} (rank ${prank}) | Due:${t.dueDate || "none"} | Source:${t.source || "?"}${parentRef}`;
    }).join("\n");

    const trainingHistory = recentLogs.length > 0
      ? recentLogs.map(l => `- Moved "${l.movedItemTitle}" above ${(l.displacedItemTitles || []).slice(0, 3).join(", ")} because: "${l.tonyExplanation}"`).join("\n")
      : "No training history yet.";

    let raw = "";

    // Flag-gated: AGENT_RUNTIME_TASKS=true routes through runtime.
    // Runtime path sends ONLY dynamic data — instructions live in the skill body
    // (loaded as a system block by prompt-builder). Legacy path keeps the
    // monolithic prompt for one-flag-flip rollback safety.
    if (isAgentRuntimeEnabled("tasks")) {
      const runtimeMessage = `BUSINESS CONTEXT:
${brainContext || businessPlanCtx || "Sales-first business. Break-even goal: $50K/month. P0 > revenue, P1 > speed, P2 > quality."}

TRAINING HISTORY (Tony's past reorder decisions):
${trainingHistory}

ACTIVE TASKS (current order, positions 1 to ${activeTasks.length}):
${taskList}

OUTPUT: compact single-line JSON only — no markdown fences, no newlines, no indentation. Format: {"priorityOrder":["uuid1","uuid2",...]}`;

      const result = await runAgent("tasks", "ai-organize", {
        userMessage: runtimeMessage,
        caller: "direct",
        meta: { activeCount: activeTasks.length },
      });
      raw = result.text.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    } else {
      const legacyPrompt = `You are Tony Diaz's AI sprint brain for FlipIQ. Your job is to determine the optimal work priority order within a two-tier hierarchy: Master tasks at top, Sub-tasks and Notes under their parent Master.

NORTH STAR METRIC: Every Acquisition Associate closes 2 deals/month. If it doesn't move an AA toward 2 deals/month, it is noise.

BUSINESS CONTEXT:
${brainContext || businessPlanCtx || "Sales-first business. Break-even goal: $50K/month. P0 > revenue, P1 > speed, P2 > quality."}

TRAINING HISTORY (Tony's past reorder decisions):
${trainingHistory}

ACTIVE TASKS (current order, positions 1 to ${activeTasks.length}):
${taskList}

HIERARCHY RULES (STRICT — do not violate):
- MASTER tasks compete with other MASTER tasks. Rank them among themselves.
- SUB tasks belong to their Parent master. Rank SUBs ONLY within their parent's children group.
- NOTES belong to their Parent master but have no priority — list them AFTER all SUBs of the same parent.
- A SUB must NEVER be reassigned to a different parent. Keep its Parent:<id> unchanged.
- Output should be structured so each Master is followed by all its SUBs (ordered) then its NOTES (in existing order).

Ranking criteria within each tier:
1. Priority field (P0 > P1 > P2)
2. Due date urgency
3. Revenue / AA deal impact
4. Training history (respect Tony's patterns)
5. Dependencies

Return ONLY a JSON object with key "priorityOrder" — array of ALL task IDs in optimal flattened tree order (Master → its SUBs → its NOTES → next Master → ...). No markdown, no explanation:
{"priorityOrder": ["masterA-id","masterA-sub1-id","masterA-sub2-id","masterA-note1-id","masterB-id","masterB-sub1-id",...]}`;

      const msg = await createTrackedMessage("plan_organize", {
        model: "claude-sonnet-4-5",
        max_tokens: 4000,
        messages: [{ role: "user", content: legacyPrompt }],
      });
      const block = msg.content[0];
      if (block.type !== "text") {
        res.status(500).json({ error: "Claude returned unexpected response" });
        return;
      }
      raw = block.text.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(raw) as { priorityOrder: string[] };

    // Validate: only IDs from the set we sent to the model are accepted.
    const validIds = new Set(activeTasks.map(t => t.id));
    const ordered = parsed.priorityOrder.filter(id => validIds.has(id));
    const missing = activeTasks.filter(t => !ordered.includes(t.id)).map(t => t.id);
    const reranked = [...ordered, ...missing];

    // In top50 mode, append the tail tasks (positions 51+) in their original order.
    // In all mode, tailTasks is empty so this is a no-op.
    const fullOrder = [...reranked, ...tailTasks.map(t => t.id)];

    const allById = new Map(allActive.map(t => [t.id, t]));
    const tasksInNewOrder = fullOrder.map(id => allById.get(id)!).filter(Boolean);

    triggerSheetsSync();
    res.json({
      priorityOrder: fullOrder,
      tasks: tasksInNewOrder,
      mode,
      organizedCount: activeTasks.length,
      totalCount: allActive.length,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /plan/brain/logs — recent training log entries
router.get("/plan/brain/logs", async (req, res): Promise<void> => {
  try {
    const logs = await db.select().from(brainTrainingLogTable)
      .orderBy(desc(brainTrainingLogTable.createdAt))
      .limit(50);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Business context docs (DB-backed source of truth) ─────────────────────
// Tony's three editable docs all live in business_context, distinguished by
// documentType. The dashboard FE reads these from /business/context/:type so
// what Tony sees in the UI matches what the AI sees in its prompts. Old
// hardcoded JS constants in BusinessView.tsx are gone — first read here
// seeds defaults if a row is missing, so nothing visible to Tony disappears.
const BUSINESS_CONTEXT_DOC_TYPES = new Set([
  "business_plan",
  "90_day_plan",
  "brain_context",
  "north_star",
  "daily_spiritual",
]);

function isValidDocType(t: string): boolean {
  return BUSINESS_CONTEXT_DOC_TYPES.has(t);
}

// GET /business/context/:documentType — load one doc, seeding default on first read.
router.get("/business/context/:documentType", async (req, res): Promise<void> => {
  try {
    const { documentType } = req.params;
    if (!isValidDocType(documentType)) {
      res.status(400).json({ error: `Unknown documentType: ${documentType}` }); return;
    }
    let [ctx] = await db.select().from(businessContextTable)
      .where(eq(businessContextTable.documentType, documentType));
    // First-read seed — keeps the old hardcoded text alive without a separate migration.
    if (!ctx && BUSINESS_CONTEXT_DEFAULTS[documentType]) {
      const seed = BUSINESS_CONTEXT_DEFAULTS[documentType];
      const [inserted] = await db.insert(businessContextTable).values({
        documentType,
        content: seed.content,
        summary: seed.summary,
      }).returning();
      ctx = inserted;
    }
    res.json({
      documentType,
      content: ctx?.content || "",
      summary: ctx?.summary || null,
      lastUpdated: ctx?.lastUpdated || null,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /business/context/:documentType — upsert one doc.
router.put("/business/context/:documentType", async (req, res): Promise<void> => {
  try {
    const { documentType } = req.params;
    if (!isValidDocType(documentType)) {
      res.status(400).json({ error: `Unknown documentType: ${documentType}` }); return;
    }
    const { content, summary } = req.body as { content: string; summary?: string };
    if (typeof content !== "string") { res.status(400).json({ error: "content is required" }); return; }
    const cleaned = content.trim();
    const existing = await db.select().from(businessContextTable)
      .where(eq(businessContextTable.documentType, documentType));
    if (existing.length > 0) {
      await db.update(businessContextTable)
        .set({ content: cleaned, summary: summary ?? existing[0].summary, lastUpdated: new Date() })
        .where(eq(businessContextTable.documentType, documentType));
    } else {
      await db.insert(businessContextTable).values({
        documentType,
        content: cleaned,
        summary: summary || BUSINESS_CONTEXT_DEFAULTS[documentType]?.summary || null,
      });
    }
    res.json({ ok: true, documentType });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Legacy aliases — kept so existing FE/AI calls to /plan/brain/context keep working.
router.put("/plan/brain/context", async (req, res): Promise<void> => {
  try {
    const { content } = req.body as { content: string };
    if (!content?.trim()) { res.status(400).json({ error: "content is required" }); return; }
    const existing = await db.select().from(businessContextTable)
      .where(eq(businessContextTable.documentType, "brain_context"));
    if (existing.length > 0) {
      await db.update(businessContextTable)
        .set({ content: content.trim(), lastUpdated: new Date() })
        .where(eq(businessContextTable.documentType, "brain_context"));
    } else {
      await db.insert(businessContextTable).values({
        documentType: "brain_context",
        content: content.trim(),
        summary: "Tony's brain context for AI sprint prioritization",
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/plan/brain/context", async (req, res): Promise<void> => {
  try {
    const [ctx] = await db.select().from(businessContextTable)
      .where(eq(businessContextTable.documentType, "brain_context"));
    res.json({ content: ctx?.content || "", lastUpdated: ctx?.lastUpdated || null });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /plan/task/:id — delete a task, with orphan handling for Master tasks
// Query params: ?action=promote|cascade|orphan (default: cascade when Master has children)
router.delete("/plan/task/:id", async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const action = (req.query.action as string) || "cascade";

    const [target] = await db.select().from(planItemsTable).where(eq(planItemsTable.id, id));
    if (!target) { res.status(404).json({ error: "Task not found" }); return; }

    // Only Master tasks can have children, so orphan logic only applies to them
    if (target.taskType === "master") {
      const children = await db.select().from(planItemsTable)
        .where(eq(planItemsTable.parentTaskId, id));

      if (children.length > 0) {
        if (action === "promote") {
          // Promote subtasks to masters; delete notes (useless without context)
          const subChildIds = children.filter(c => c.taskType === "subtask").map(c => c.id);
          const noteChildIds = children.filter(c => c.taskType === "note").map(c => c.id);
          if (subChildIds.length > 0) {
            await db.update(planItemsTable)
              .set({ taskType: "master", parentTaskId: null })
              .where(inArray(planItemsTable.id, subChildIds));
          }
          if (noteChildIds.length > 0) {
            await db.delete(planItemsTable).where(inArray(planItemsTable.id, noteChildIds));
          }
        } else if (action === "cascade") {
          // Delete all children (sub-tasks and notes)
          await db.delete(planItemsTable).where(eq(planItemsTable.parentTaskId, id));
        } else if (action === "orphan") {
          // Leave children with dangling parentTaskId (they'll render in "Orphaned" group)
          // No-op — children stay as-is
        }
      }
    }

    await db.delete(planItemsTable).where(eq(planItemsTable.id, id));
    triggerSheetsSync();
    res.json({ ok: true, action });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /plan/task/:id/children — count children (for delete-confirmation dialog)
router.get("/plan/task/:id/children", async (req, res): Promise<void> => {
  try {
    const { id } = req.params;
    const children = await db.select({ id: planItemsTable.id, taskType: planItemsTable.taskType, title: planItemsTable.title })
      .from(planItemsTable)
      .where(eq(planItemsTable.parentTaskId, id));
    const subCount = children.filter(c => c.taskType === "subtask").length;
    const noteCount = children.filter(c => c.taskType === "note").length;
    res.json({ ok: true, total: children.length, subCount, noteCount, children });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Brain scoring helper for new Linear tasks ───────────────────────────────
async function brainScoreNewTask(title: string, category: string, priority: string): Promise<number> {
  try {
    const activeTasks = await db.select({ id: planItemsTable.id, title: planItemsTable.title, category: planItemsTable.category, priority: planItemsTable.priority, priorityOrder: planItemsTable.priorityOrder })
      .from(planItemsTable)
      .where(and(eq(planItemsTable.level, "task"), eq(planItemsTable.status, "active")))
      .orderBy(asc(planItemsTable.priorityOrder));

    if (activeTasks.length === 0) return 0;

    const recentLogs = await db.select().from(brainTrainingLogTable)
      .orderBy(desc(brainTrainingLogTable.createdAt))
      .limit(10);

    let brainContext = "";
    try {
      const [ctx] = await db.select().from(businessContextTable)
        .where(eq(businessContextTable.documentType, "brain_context"));
      if (ctx?.content) brainContext = ctx.content.substring(0, 1000);
    } catch { /**/ }

    const taskList = activeTasks.map((t, i) => `${i}: [${t.category}] ${t.title} (${t.priority || "P2"})`).join("\n");
    const trainingContext = recentLogs.length > 0
      ? recentLogs.map(l => `- Moved "${l.movedItemTitle}" above: "${(l.displacedItemTitles || []).slice(0, 2).join(", ")}" because: "${l.tonyExplanation}"`).join("\n")
      : "";

    let raw = "";

    // Flag-gated: AGENT_RUNTIME_TASKS=true routes through runtime.
    // Runtime path sends only dynamic data — instructions live in skill body.
    if (isAgentRuntimeEnabled("tasks")) {
      const runtimeMessage = `NEW TASK: "${title}" | Category: ${category} | Priority: ${priority || "P1"}

BRAIN CONTEXT: ${brainContext || "Sales-first business. P0 > revenue, P1 > speed, P2 > quality."}

TRAINING PATTERNS:
${trainingContext || "None yet."}

CURRENT TASK ORDER (index: task):
${taskList.substring(0, 2000)}`;

      const result = await runAgent("tasks", "score-new-task", {
        userMessage: runtimeMessage,
        caller: "direct",
        meta: { taskTitle: title, category, priority },
      });
      raw = result.text.trim();
    } else {
      const prompt = `You are Tony Diaz's sprint brain for FlipIQ. A new task was just added from Linear and needs to be inserted at the right priority position.

NEW TASK: "${title}" | Category: ${category} | Priority: ${priority || "P1"}

BRAIN CONTEXT: ${brainContext || "Sales-first business. P0 > revenue, P1 > speed, P2 > quality."}

TRAINING PATTERNS:
${trainingContext || "None yet."}

CURRENT TASK ORDER (index: task):
${taskList.substring(0, 2000)}

At which index (0 = top) should the new task be inserted? Consider:
1. Its priority (${priority}) vs surrounding tasks
2. Its category alignment (${category}) with Tony's patterns
3. Business impact (does it unblock sales or operators?)

Return ONLY a JSON object: {"insertAt": <number>}`;

      const msg = await createTrackedMessage("plan_organize", {
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: prompt }],
      });
      const block = msg.content[0];
      if (block.type !== "text") return Math.floor(activeTasks.length / 2);
      raw = block.text.trim();
    }

    const parsed = JSON.parse(raw) as { insertAt: number };
    return Math.min(Math.max(0, parsed.insertAt), activeTasks.length);
  } catch (e) {
    console.warn("[plan] brainScoreNewTask failed:", e);
    return 0; // Default to top if brain scoring fails
  }
}

// POST /plan/linear-webhook — receive Linear webhook events
router.post("/plan/linear-webhook", async (req, res): Promise<void> => {
  try {
    const { action, type, data } = req.body;

    if (type !== "Issue") {
      res.json({ ok: true, skipped: true });
      return;
    }

    const linearId = data?.id;

    if (!linearId) {
      res.json({ ok: true, skipped: true });
      return;
    }

    // ── Handle new issue creation ─────────────────────────────────────────
    if (action === "create") {
      const title = data?.title;
      if (!title?.trim()) {
        res.json({ ok: true, skipped: true, reason: "no title" });
        return;
      }

      // Check if already imported
      const [existing] = await db.select().from(planItemsTable)
        .where(and(eq(planItemsTable.linearId, linearId), eq(planItemsTable.level, "task")));
      if (existing) {
        res.json({ ok: true, skipped: true, reason: "already exists" });
        return;
      }

      // Infer category from Linear team/label if available
      const teamName: string = (data?.team?.name || "").toLowerCase();
      let category = "tech";
      if (teamName.includes("sales") || teamName.includes("growth")) category = "sales";
      else if (teamName.includes("ops") || teamName.includes("adapt")) category = "adaptation";
      else if (teamName.includes("cap") || teamName.includes("finance")) category = "capital";
      else if (teamName.includes("team") || teamName.includes("hr")) category = "team";

      // Linear priority: 0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low
      const priority = data?.priority === 1 ? "P0" : data?.priority === 2 ? "P1" : "P2";
      const dueDate = data?.dueDate?.substring(0, 10) || null;
      const assignee = data?.assignee?.name || null;

      // Brain scoring: find optimal priority order position
      const insertAt = await brainScoreNewTask(title, category, priority);

      // Shift existing tasks down to make room
      const activeTasks = await db.select({ id: planItemsTable.id, priorityOrder: planItemsTable.priorityOrder })
        .from(planItemsTable)
        .where(and(eq(planItemsTable.level, "task"), eq(planItemsTable.status, "active")))
        .orderBy(asc(planItemsTable.priorityOrder));

      for (const t of activeTasks) {
        if ((t.priorityOrder ?? 0) >= insertAt) {
          await db.update(planItemsTable)
            .set({ priorityOrder: (t.priorityOrder ?? 0) + 1, updatedAt: new Date() })
            .where(eq(planItemsTable.id, t.id));
        }
      }

      const [newTask] = await db.insert(planItemsTable).values({
        level: "task",
        category,
        title: title.trim(),
        owner: assignee,
        priority,
        status: "active",
        priorityOrder: insertAt,
        linearId,
        source: "Linear",
        dueDate: dueDate || undefined,
      }).returning();

      console.log(`[plan] Linear webhook: inserted "${title}" at position ${insertAt} (brain-scored)`);
      res.json({ ok: true, taskId: newTask.id, insertedAt: insertAt, action: "created" });
      return;
    }

    // ── Handle status updates ─────────────────────────────────────────────
    if (action === "update") {
      const stateType = data?.state?.type;
      if (!stateType) {
        res.json({ ok: true, skipped: true });
        return;
      }

      const [task] = await db.select().from(planItemsTable)
        .where(and(eq(planItemsTable.linearId, linearId), eq(planItemsTable.level, "task")));

      if (!task) {
        res.json({ ok: true, skipped: true, reason: "no matching task" });
        return;
      }

      if (stateType === "completed" && task.status !== "completed") {
        await db.update(planItemsTable)
          .set({ status: "completed", completedAt: new Date(), completedBy: "Linear", updatedAt: new Date() })
          .where(eq(planItemsTable.id, task.id));
        await checkParentCompletion(task.id);
        console.log(`[plan] Linear webhook: marked ${task.title} completed`);
      } else if ((stateType === "started" || stateType === "unstarted") && task.status === "completed") {
        await db.update(planItemsTable)
          .set({ status: "active", completedAt: null, completedBy: null, updatedAt: new Date() })
          .where(eq(planItemsTable.id, task.id));
      }

      res.json({ ok: true, taskId: task.id, action: "updated" });
      return;
    }

    res.json({ ok: true, skipped: true, reason: "unhandled action" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /plan/seed — re-seed (admin)
router.post("/plan/seed", async (_req, res): Promise<void> => {
  try {
    await db.delete(planItemsTable);
    await seedPlanIfEmpty();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── POST /plan/task/notify-assignee — Slack DM the task owner ──────────────
// Triggered when Tony checks "Notify assignee on Slack" in the AddTask modal.
// Resolves the owner's Slack ID by name (Linear members → Slack-by-email →
// Slack-by-display-name), then sends a DM with the task details and asks the
// owner to mirror the task into Linear.
router.post("/plan/task/notify-assignee", async (req, res): Promise<void> => {
  const body = req.body as {
    taskTitle?: string;
    owner?: string;
    priority?: string;
    dueDate?: string;
    workNotes?: string;
    category?: string;
  };
  const { taskTitle, owner, priority, dueDate, workNotes, category } = body;
  if (!taskTitle || !owner) {
    res.status(400).json({ ok: false, error: "taskTitle and owner are required" });
    return;
  }

  try {
    const [linearRes, slackRes] = await Promise.allSettled([
      getLinearMembers(),
      listSlackUsers(),
    ]);
    const linear = linearRes.status === "fulfilled" ? linearRes.value : [];
    const slackUsers = slackRes.status === "fulfilled" ? (slackRes.value.members ?? []) : [];

    const ownerLower = owner.toLowerCase().trim();
    const linearMatch = linear.find(
      (m) => (m.displayName || m.name).toLowerCase() === ownerLower || m.name.toLowerCase() === ownerLower,
    );
    const linearEmail = linearMatch?.email?.toLowerCase();

    const slackById = (id: string) => slackUsers.find((su) => su.id === id);
    let slackUserId: string | null = null;
    if (linearEmail) {
      const byEmail = slackUsers.find((su) => su.profile?.email?.toLowerCase() === linearEmail);
      if (byEmail) slackUserId = byEmail.id;
    }
    if (!slackUserId) {
      const byDisplayName = slackUsers.find((su) => {
        const dn = (su.profile?.display_name || su.real_name || "").toLowerCase();
        return dn === ownerLower;
      });
      if (byDisplayName) slackUserId = byDisplayName.id;
    }

    if (!slackUserId) {
      res.status(404).json({ ok: false, error: `Could not find a Slack account for "${owner}"` });
      return;
    }

    // Send the DM. The message asks the owner to create the matching Linear
    // ticket so the work shows up in their queue.
    const su = slackById(slackUserId);
    const ownerDisplay = su?.profile?.display_name || su?.real_name || owner;
    const result = await notifyAssigneeViaSlack({
      slackUserId,
      ideaText: taskTitle,
      category: category || "task",
      urgency: priority || "—",
      dueDate: dueDate || "—",
      assigneeName: ownerDisplay,
      note: workNotes || "Tony just assigned this task in TCC. Please mirror it into Linear so it shows up in your queue.",
    });

    res.json({ ok: result.ok, slackUserId, owner: ownerDisplay });
  } catch (err) {
    console.warn("[plan/task/notify-assignee] failed:", err instanceof Error ? err.message : err);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
