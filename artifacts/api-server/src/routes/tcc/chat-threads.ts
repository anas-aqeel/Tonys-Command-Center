import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, desc, and, sql, asc } from "drizzle-orm";
import { anthropic, createTrackedMessage, createTrackedStream } from "@workspace/integrations-anthropic-ai";
import { sharedDb, personalDb, systemInstructionsTable, contactsTable } from "@workspace/db";
import { chatThreadsTable, chatMessagesTable, communicationLogTable, contactIntelligenceTable, companyGoalsTable, teamRolesTable } from "../../lib/schema-v2";
import { createLinearIssue, getLinearIssues, getLinearMembers } from "../../lib/linear";
import { postSlackMessage, getSlackChannelHistory, listSlackChannels, searchSlack } from "../../lib/slack";
import { sendEmail, listRecentEmails, draftReply } from "../../lib/gmail";
import { getTodayEvents, createEvent } from "../../lib/gcal";
import { listDriveFiles } from "../../lib/google-drive";
import { sendAutoEod } from "./eod";

const router: IRouter = Router();

const TOOLS: Parameters<typeof anthropic.messages.create>[0]["tools"] = [
  {
    name: "send_slack_message",
    description: "Post a message to a FlipIQ Slack channel.",
    input_schema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: "Slack channel name, e.g. #tech-ideas, #sales" },
        message: { type: "string", description: "The message text to post" },
      },
      required: ["channel", "message"],
    },
  },
  {
    name: "create_linear_issue",
    description: "Create a Linear issue for a tech task or bug.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short, clear issue title" },
        description: { type: "string", description: "Full description" },
        priority: { type: "number", description: "1=urgent, 2=high, 3=medium, 4=low" },
      },
      required: ["title", "description"],
    },
  },
  {
    name: "send_email",
    description: `Send an email on ${process.env.TCC_USER_NAME || "Tony"}'s behalf via Gmail from ${process.env.TCC_USER_EMAIL || "tony@flipiq.com"}.`,
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "compose_email",
    description: "Open the EmailCompose view pre-filled for Tony to review before sending. Does NOT auto-send.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        cc: { type: "string" },
        threadId: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "schedule_meeting",
    description: "Create a calendar event. SCOPE GATEKEEPER: Only for sales calls, prospect meetings, or Ramy support.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
        description: { type: "string" },
        location: { type: "string" },
        purpose: { type: "string", description: "'sales', 'ramy_support', or 'other'" },
      },
      required: ["summary", "start", "end", "purpose"],
    },
  },
  {
    name: "research_contact",
    description: "Look up a contact's details, communication history, and intelligence from the database.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        contactId: { type: "string" },
        webSearch: { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "update_contact_stage",
    description: "Update a contact's sales pipeline stage: new, outreach, engaged, meeting_scheduled, negotiating, closed, dormant.",
    input_schema: {
      type: "object" as const,
      properties: {
        contactId: { type: "string" },
        stage: { type: "string" },
      },
      required: ["contactId", "stage"],
    },
  },
  {
    name: "create_task",
    description: "Create a Linear issue as a task.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "number" },
      },
      required: ["title"],
    },
  },
  {
    name: "get_email_brain",
    description: "Retrieve Tony's learned email priority rules.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "list_recent_emails",
    description: "Fetch Tony's recent unread Gmail messages.",
    input_schema: {
      type: "object" as const,
      properties: { max_results: { type: "number" } },
      required: [],
    },
  },
  {
    name: "draft_gmail_reply",
    description: "Create a Gmail draft reply for Tony to review. Does NOT auto-send.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        thread_id: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "read_slack_channel",
    description: "Read recent messages from a Slack channel.",
    input_schema: {
      type: "object" as const,
      properties: { channel: { type: "string" }, limit: { type: "number" } },
      required: ["channel"],
    },
  },
  {
    name: "list_slack_channels",
    description: "List all Slack channels.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "search_slack",
    description: "Search Slack messages.",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "get_today_calendar",
    description: "Fetch today's calendar events.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_calendar_event",
    description: "Create a Google Calendar event.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string" },
        description: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "search_drive",
    description: "Search Google Drive for files by name or content.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" },
        max_results: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "send_eod_report",
    description: `Generate and send today's End of Day (EOD) report. Sends ${(process.env.TCC_USER_NAME || "Tony").split(/\s+/)[0]}'s performance summary to ${process.env.TCC_USER_EMAIL || "tony@flipiq.com"} and accountability brief to ${process.env.TCC_ACCOUNTABILITY_EMAIL || "ethan@flipiq.com"}. Guards against double-sending.`,
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_all_tasks",
    description: "Fetch ALL open Linear tasks/issues with status, priority, assignee, and due dates. Use this when the user asks about Linear, tasks, issues, tickets, due dates, team progress, or what's overdue.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_linear_members",
    description: "List all active Linear team members with their IDs, names, and emails. Call this before assigning issues.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_calendar_range",
    description: "Fetch calendar events for a specific date range.",
    input_schema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date (ISO format or YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (ISO format or YYYY-MM-DD)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "query_database",
    description: "Execute a read-only SQL SELECT query. Use target='shared' for business/contacts tables, target='personal' for user data (checkins, ideas, chat, agent config).",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "SQL SELECT query" },
        target: { type: "string", enum: ["shared", "personal"], description: "Which database to query: 'shared' for business/contacts, 'personal' for user data. Defaults to 'personal'." },
      },
      required: ["query"],
    },
  },
  {
    name: "search_contacts",
    description: "Search contacts by name, company, or type.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search term (name, company, etc.)" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_communication_log",
    description: "Fetch recent entries from Tony's communication log (emails, calls, texts). Optionally filter by contact name or channel.",
    input_schema: {
      type: "object" as const,
      properties: {
        contact_name: { type: "string", description: "Filter by contact name (optional)" },
        channel: { type: "string", description: "Filter by channel: email, call, sms, slack (optional)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: [],
    },
  },
];

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "send_slack_message": {
      const result = await postSlackMessage({ channel: String(input.channel), text: String(input.message) });
      return result.ok ? `Message posted to ${input.channel}` : `Slack error: ${result.error}`;
    }
    case "read_slack_channel": {
      const result = await getSlackChannelHistory({ channel: String(input.channel), limit: Math.min(Number(input.limit) || 10, 50) });
      if (!result.ok) return `Slack error: ${result.error}`;
      if (!result.messages?.length) return `No recent messages in ${input.channel}.`;
      return result.messages.map((m, i) => {
        const time = new Date(parseFloat(m.ts) * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        return `${i + 1}. [${time}] ${m.username || m.user || "user"}: ${m.text}`;
      }).join("\n");
    }
    case "list_slack_channels": {
      const result = await listSlackChannels();
      if (!result.ok) return `Slack error: ${result.error}`;
      return (result.channels || []).map(c => `#${c.name}${c.is_member ? " (joined)" : ""}`).join(", ");
    }
    case "search_slack": {
      const result = await searchSlack(String(input.query));
      if (!result.ok) return `Slack search error: ${result.error}`;
      if (!result.messages?.length) return `No results for "${input.query}".`;
      return result.messages.map((m, i) => `${i + 1}. [#${(m.channel as any)?.name || "?"}] ${m.text}`).join("\n");
    }
    case "create_linear_issue":
    case "create_task": {
      const result = await createLinearIssue({
        title: String(input.title),
        description: String(input.description || ""),
        priority: typeof input.priority === "number" ? input.priority : 3,
      });
      return result.ok ? `Linear issue created: ${result.identifier ?? result.id}` : `Linear issue creation failed`;
    }
    case "send_email": {
      const result = await sendEmail({ to: String(input.to), subject: String(input.subject), body: String(input.body) });
      return result.ok ? `Email sent to ${input.to} via Gmail` : `Email send failed: ${result.error || "unknown error"}`;
    }
    case "compose_email": {
      return JSON.stringify({
        action: "open_compose",
        to: String(input.to),
        subject: String(input.subject),
        body: String(input.body),
        cc: input.cc ? String(input.cc) : undefined,
        threadId: input.threadId ? String(input.threadId) : undefined,
      });
    }
    case "schedule_meeting": {
      const purpose = String(input.purpose || "other").toLowerCase();
      if (purpose !== "sales" && purpose !== "ramy_support") {
        return `SCOPE GATEKEEPER: This meeting doesn't appear to be sales-related or Ramy support. Tony's priority: (1) Sales, (2) Ramy support, (3) everything else pushed back. Suggest scheduling this after sales hours.`;
      }
      const result = await createEvent({
        summary: String(input.summary), start: String(input.start), end: String(input.end),
        attendees: Array.isArray(input.attendees) ? input.attendees.map(String) : undefined,
        description: input.description ? String(input.description) : undefined,
        location: input.location ? String(input.location) : undefined,
      });
      return result.ok ? `Meeting "${input.summary}" created` : `Calendar event creation failed`;
    }
    case "research_contact": {
      try {
        let contact;
        if (input.contactId) {
          [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, String(input.contactId))).limit(1);
        } else if (input.name) {
          [contact] = await sharedDb.select().from(contactsTable)
            .where(sql`LOWER(name) LIKE LOWER(${"%" + String(input.name) + "%"})`)
            .limit(1);
        }
        if (!contact) return `No contact found for "${input.name || input.contactId}".`;

        const [intel] = await sharedDb.select().from(contactIntelligenceTable)
          .where(eq(contactIntelligenceTable.contactId, contact.id)).limit(1);

        const recentComms = await sharedDb.select().from(communicationLogTable)
          .where(eq(communicationLogTable.contactId, contact.id))
          .orderBy(desc(communicationLogTable.loggedAt)).limit(5);

        let result = `CONTACT: ${contact.name}\nCompany: ${contact.company || "N/A"}\nStatus: ${contact.status}\nPhone: ${contact.phone || "N/A"}\nEmail: ${contact.email || "N/A"}\nType: ${contact.type || "N/A"}\nNext Step: ${contact.nextStep || "None"}`;

        if (intel) {
          result += `\n\nINTELLIGENCE:\nAI Score: ${intel.aiScore || "Not scored"}\nStage: ${intel.stage}\nLinkedIn: ${intel.linkedinUrl || "N/A"}\nPersonality: ${intel.personalityNotes || "N/A"}\nTotal Calls: ${intel.totalCalls}\nTotal Emails: ${intel.totalEmailsSent} sent / ${intel.totalEmailsReceived} received\nLast Comm: ${intel.lastCommunicationDate || "Never"} via ${intel.lastCommunicationType || "N/A"}`;
        }

        if (recentComms.length > 0) {
          result += `\n\nRECENT COMMUNICATIONS:`;
          for (const c of recentComms) {
            result += `\n- [${c.channel}] ${c.loggedAt ? new Date(c.loggedAt).toLocaleDateString() : "?"}: ${c.summary || c.subject || "No summary"}`;
          }
        }

        if (input.webSearch) {
          result += `\n\n[WEB_SEARCH_REQUESTED for contactId: ${contact.id}]`;
        }

        return result;
      } catch (err) {
        return `Contact lookup failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "update_contact_stage": {
      const VALID_STAGES = ["new", "outreach", "engaged", "meeting_scheduled", "negotiating", "closed", "dormant"];
      const stage = String(input.stage);
      if (!VALID_STAGES.includes(stage)) return `Invalid stage "${stage}". Valid: ${VALID_STAGES.join(", ")}`;
      try {
        await sharedDb.update(contactIntelligenceTable)
          .set({ stage, updatedAt: new Date() })
          .where(eq(contactIntelligenceTable.contactId, String(input.contactId)));
        return `Contact stage updated to "${stage}"`;
      } catch { return `Stage update failed — contact_intelligence row may not exist yet.`; }
    }
    case "get_email_brain": {
      const [row] = await personalDb.select().from(systemInstructionsTable).where(eq(systemInstructionsTable.section, "email_brain"));
      return row?.content ? `Email Brain:\n${row.content}` : "No email brain yet.";
    }
    case "list_recent_emails": {
      const emails = await listRecentEmails(Math.min(Number(input.max_results) || 5, 10));
      if (!emails.length) return "No recent unread emails.";
      return emails.map((e, i) => `${i + 1}. From: ${e.from}\n   Subject: ${e.subject}\n   Snippet: ${e.snippet}\n   Date: ${e.date}`).join("\n\n");
    }
    case "draft_gmail_reply": {
      const result = await draftReply({ to: String(input.to), subject: String(input.subject), body: String(input.body), threadId: input.thread_id ? String(input.thread_id) : undefined });
      return result.ok ? `Gmail draft created (id: ${result.draftId}). Tony reviews in Gmail.` : `Draft creation failed: ${result.error}`;
    }
    case "get_today_calendar": {
      const events = await getTodayEvents();
      if (!events.length) return "No events today.";
      return events.map((e, i) => {
        const start = new Date(e.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        const end = new Date(e.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        return `${i + 1}. ${e.summary} (${start}–${end})${e.location ? ` @ ${e.location}` : ""}`;
      }).join("\n");
    }
    case "create_calendar_event": {
      const result = await createEvent({
        summary: String(input.summary), start: String(input.start), end: String(input.end),
        attendees: Array.isArray(input.attendees) ? input.attendees.map(String) : undefined,
        description: input.description ? String(input.description) : undefined,
      });
      return result.ok ? `Event created: ${input.summary}` : `Event creation failed`;
    }
    case "search_drive": {
      try {
        const rawQuery = String(input.query).replace(/'/g, "\\'");
        const maxResults = Math.min(Number(input.max_results) || 5, 10);
        // Use name-based search (works with drive.file scope); fall back gracefully
        const files = await listDriveFiles(`name contains '${rawQuery}' and trashed = false`, maxResults);
        if (!files.length) {
          return `No Drive files found matching "${input.query}".\n\nKnown resources:\n- Business Master Sheet: https://docs.google.com/spreadsheets/d/1VXx88LTbuoTrnEssB50kBelGPX_nCVcclVrEAxJGEqE`;
        }
        return files.map((f, i) => {
          const link = f.mimeType?.includes("spreadsheet")
            ? `https://docs.google.com/spreadsheets/d/${f.id}`
            : f.mimeType?.includes("document")
            ? `https://docs.google.com/document/d/${f.id}`
            : `https://drive.google.com/file/d/${f.id}`;
          return `${i + 1}. ${f.name}\n   ${link}\n   Modified: ${f.modifiedTime}`;
        }).join("\n\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Insufficient Permission") || msg.includes("insufficientPermissions")) {
          return `Drive search is limited by permissions. Here are Tony's known resources:\n- Business Master Sheet: https://docs.google.com/spreadsheets/d/1VXx88LTbuoTrnEssB50kBelGPX_nCVcclVrEAxJGEqE`;
        }
        return `Drive search failed: ${msg}`;
      }
    }
    case "send_eod_report": {
      const result = await sendAutoEod();
      if (result.alreadySent) return `✓ EOD report already sent today — no duplicate sent.`;
      if (!result.ok) return `✗ EOD report failed to generate.`;
      return `✓ EOD report sent!\n- Calls: ${result.callsMade ?? 0}\n- Demos: ${result.demosBooked ?? 0}\n- Tasks: ${result.tasksCompleted ?? 0}\n\n${(process.env.TCC_USER_NAME || "Tony").split(/\s+/)[0]} → ${process.env.TCC_USER_EMAIL || "tony@flipiq.com"}\n${(process.env.TCC_ACCOUNTABILITY_EMAIL || "ethan@flipiq.com").split("@")[0]} → ${process.env.TCC_ACCOUNTABILITY_EMAIL || "ethan@flipiq.com"}`;
    }
    case "get_all_tasks": {
      try {
        const issues = await getLinearIssues();
        if (issues.length === 0) return "No open Linear tasks found.";
        return issues.map((t: any, i: number) => {
          const priority = ["", "Urgent", "High", "Medium", "Low"][t.priority] || "Unknown";
          const due = t.dueDate ? ` | Due: ${t.dueDate}` : " | Due: NOT SET";
          const assignee = t.assignee?.name ? ` | Assignee: ${t.assignee.name}` : "";
          return `${i + 1}. [${t.identifier}] ${t.title}\n   Status: ${t.state?.name || "Unknown"} | Priority: ${priority}${due}${assignee}`;
        }).join("\n\n");
      } catch (err) {
        return `Failed to fetch Linear tasks: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "get_linear_members": {
      try {
        const members = await getLinearMembers();
        return members.map((m: any) => `${m.name} (${m.email}) — ID: ${m.id}`).join("\n");
      } catch (err) {
        return `Failed to fetch Linear members: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "get_calendar_range": {
      try {
        const { getCalendar } = await import("../../lib/google-auth");
        const cal = await getCalendar();
        const events = await cal.events.list({
          calendarId: "primary",
          timeMin: new Date(String(input.start_date)).toISOString(),
          timeMax: new Date(String(input.end_date)).toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 50,
        });
        const items = events.data.items || [];
        if (!items.length) return "No events in that range.";
        return items.map((e: any, i: number) => {
          const start = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }) : e.start?.date || "?";
          return `${i + 1}. ${e.summary || "Untitled"} — ${start}`;
        }).join("\n");
      } catch (err) {
        return `Calendar range fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "query_database": {
      const q = String(input.query).trim();
      const target = String(input.target || "personal").toLowerCase();
      if (!/^SELECT/i.test(q)) return "Only SELECT queries are allowed.";
      if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i.test(q)) return "Only SELECT queries are allowed.";
      try {
        const queryDb = target === "shared" ? sharedDb : personalDb;
        const result = await queryDb.execute(sql.raw(q));
        const rows = Array.isArray(result) ? result : (result as any).rows || [];
        if (rows.length === 0) return "Query returned 0 rows.";
        return rows.slice(0, 50).map((r: any) => JSON.stringify(r)).join("\n");
      } catch (err) {
        return `Query failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "search_contacts": {
      try {
        const term = `%${String(input.query)}%`;
        const lim = Math.min(Number(input.limit) || 10, 25);
        const results = await sharedDb.select().from(contactsTable)
          .where(sql`LOWER(name) LIKE LOWER(${term}) OR LOWER(company) LIKE LOWER(${term})`)
          .limit(lim);
        if (!results.length) return `No contacts matching "${input.query}".`;
        return results.map((c, i) => `${i + 1}. ${c.name} | ${c.company || "N/A"} | ${c.status} | ${c.phone || "N/A"} | ${c.email || "N/A"}`).join("\n");
      } catch (err) {
        return `Contact search failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "get_communication_log": {
      try {
        const lim = Math.min(Number(input.limit) || 20, 50);
        let results;
        if (input.contact_name) {
          const [contact] = await sharedDb.select().from(contactsTable)
            .where(sql`LOWER(name) LIKE LOWER(${`%${String(input.contact_name)}%`})`)
            .limit(1);
          if (!contact) return `No contact found matching "${input.contact_name}".`;
          results = await sharedDb.select().from(communicationLogTable)
            .where(eq(communicationLogTable.contactId, contact.id))
            .orderBy(desc(communicationLogTable.loggedAt)).limit(lim);
        } else {
          results = await sharedDb.select().from(communicationLogTable)
            .orderBy(desc(communicationLogTable.loggedAt)).limit(lim);
        }
        if (!results.length) return "No communication log entries found.";
        return results.map((c, i) => `${i + 1}. [${c.channel}] ${c.loggedAt ? new Date(c.loggedAt).toLocaleDateString() : "?"} — ${c.summary || c.subject || "No summary"}`).join("\n");
      } catch (err) {
        return `Comm log fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

async function buildSystemPrompt(contextType?: string, contextId?: string): Promise<string> {
  const [brainRow] = await personalDb.select().from(systemInstructionsTable).where(eq(systemInstructionsTable.section, "email_brain"));
  const brainSection = brainRow?.content ? `\n\nEMAIL BRAIN:\n${brainRow.content}` : "";

  // Load live 411 goals and team roster for context injection
  let goalsSection = "";
  let teamSection = "";
  try {
    const [activeGoals, team] = await Promise.all([
      sharedDb.select().from(companyGoalsTable)
        .where(eq(companyGoalsTable.status, "active"))
        .orderBy(asc(companyGoalsTable.position))
        .limit(25),
      sharedDb.select().from(teamRolesTable)
        .orderBy(asc(teamRolesTable.position))
        .limit(20),
    ]);
    if (activeGoals.length > 0) {
      const HORIZONS = ["5yr", "1yr", "quarterly", "monthly", "weekly", "daily"];
      const grouped: Record<string, typeof activeGoals> = {};
      for (const h of HORIZONS) grouped[h] = [];
      for (const g of activeGoals) {
        const h = g.horizon || "other";
        if (!grouped[h]) grouped[h] = [];
        grouped[h].push(g);
      }
      const lines: string[] = ["\n\nFLIPIQ 411 GOAL CASCADE (active):"];
      for (const h of HORIZONS) {
        const items = grouped[h];
        if (!items || items.length === 0) continue;
        lines.push(`${h.toUpperCase()}: ${items.map((g: typeof activeGoals[0]) => `${g.title} (${g.owner || "Tony"})`).join(" | ")}`);
      }
      goalsSection = lines.join("\n");
    }
    if (team.length > 0) {
      const lines: string[] = ["\n\nFLIPIQ TEAM:"];
      for (const m of team) {
        lines.push(`${m.name} — ${m.role}${m.currentFocus ? ` | Focus: ${m.currentFocus}` : ""}${m.slackId ? ` | Slack: ${m.slackId}` : ""}${m.email ? ` | ${m.email}` : ""}`);
      }
      teamSection = lines.join("\n");
    }
  } catch { /* non-blocking */ }

  const userName = process.env.TCC_USER_NAME || "Tony Diaz";
  const userFirstName = userName.split(/\s+/)[0];
  const userRole = process.env.TCC_USER_ROLE || "CEO";

  let contextSection = "";
  if (contextType === "contact" && contextId) {
    const [contact] = await sharedDb.select().from(contactsTable).where(eq(contactsTable.id, contextId)).limit(1);
    if (contact) {
      contextSection = `\n\nCURRENT CONTEXT -- Contact: ${contact.name}\nCompany: ${contact.company || "N/A"}\nStatus: ${contact.status}\nPhone: ${contact.phone || "N/A"}\nEmail: ${contact.email || "N/A"}\nNext Step: ${contact.nextStep || "None"}\n\nYou are helping ${userFirstName} with this contact. Use research_contact for more details.`;
    }
  } else if (contextType === "email") {
    contextSection = `\n\nCURRENT CONTEXT -- Email. ${userFirstName} opened chat from an email. Help him reply or take action. Use compose_email to draft (${userFirstName} sends via Gmail).`;
  } else if (contextType === "schedule" || contextType === "calendar") {
    contextSection = `\n\nCURRENT CONTEXT -- Schedule. Help with meetings, time blocks, calendar.`;
  } else if (contextType === "task") {
    contextSection = `\n\nCURRENT CONTEXT -- Task. Help ${userFirstName} work through it or break it down.`;
  }

  return `You are ${userName}'s Command Center AI -- his personal operating system for FlipIQ.

ABOUT ${userFirstName.toUpperCase()}:
- ${userRole} of FlipIQ, real estate wholesale platform
- Be clear, direct, action-oriented. Keep responses scannable.
- North Star: Every Acquisition Associate closes 2 deals/month
- Revenue: $50K break-even → $100K Phase 1 → $250K Scale

RULES:
- "Today, I will follow the plan I wrote when I was clear."
- Morning block = Sales calls ONLY. No distractions.
- Ideas get parked and evaluated against North Star + 90-day plan.

SCOPE GATEKEEPER:
- If ${userFirstName} drifts into non-sales activities during prime hours, redirect him.
- For compose_email: draft for review, ${userFirstName} sends via Gmail himself.
- For schedule_meeting: only sales or support meetings allowed.

LINEAR (project management tool — NOT a Slack channel):
- When ${userFirstName} asks about "Linear", "tasks", "issues", "tickets", "due dates", "team progress", or "what's overdue" → use get_all_tasks to fetch all Linear issues
- To assign issues, call get_linear_members first to get user IDs, then create_linear_issue
- NEVER search Slack for Linear data — Linear is a separate tool, use get_all_tasks

KNOWN RESOURCES (always use these direct links — do not search Drive for these):
- FlipIQ Business Master Sheet: https://docs.google.com/spreadsheets/d/1VXx88LTbuoTrnEssB50kBelGPX_nCVcclVrEAxJGEqE
- FlipIQ Master Contact List: https://docs.google.com/spreadsheets/d/1VXx88LTbuoTrnEssB50kBelGPX_nCVcclVrEAxJGEqE

BE BRIEF. ${userFirstName} doesn't like to read. Bullet points, not paragraphs.${brainSection}${goalsSection}${teamSection}${contextSection}`;
}

async function autoTitle(threadId: string, firstMessage: string): Promise<void> {
  try {
    const response = await createTrackedMessage("chat_thread", {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 30,
      messages: [{ role: "user", content: `Generate a 3-6 word title for this conversation. Title only, no quotes.\n\n"${firstMessage.substring(0, 200)}"` }],
    });
    const titleBlock = response.content.find(b => b.type === "text");
    if (titleBlock?.type === "text" && titleBlock.text) {
      await personalDb.update(chatThreadsTable).set({ title: titleBlock.text.replace(/"/g, "").trim() }).where(eq(chatThreadsTable.id, threadId));
    }
  } catch { /* title is optional */ }
}

router.get("/chat/threads", async (_req, res): Promise<void> => {
  const threads = await personalDb.select().from(chatThreadsTable)
    .orderBy(
      desc(chatThreadsTable.pinned),
      desc(chatThreadsTable.pinnedAt),
      desc(chatThreadsTable.updatedAt),
    )
    .limit(50);
  res.json(threads);
});

const CreateThreadBody = z.object({
  contextType: z.enum(["general", "contact", "email", "schedule", "calendar", "task"]).optional().default("general"),
  contextId: z.string().optional(),
  contextLabel: z.string().optional(),
  title: z.string().optional(),
});

router.post("/chat/threads", async (req, res): Promise<void> => {
  const parsed = CreateThreadBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [thread] = await personalDb.insert(chatThreadsTable).values({
    contextType: parsed.data.contextType,
    contextId: parsed.data.contextId || undefined,
    title: parsed.data.title || (parsed.data.contextLabel ? `Re: ${parsed.data.contextLabel}` : undefined),
  }).returning();

  res.json(thread);
});

router.delete("/chat/threads/:threadId", async (req, res): Promise<void> => {
  await personalDb.delete(chatMessagesTable).where(eq(chatMessagesTable.threadId, req.params.threadId));
  await personalDb.delete(chatThreadsTable).where(eq(chatThreadsTable.id, req.params.threadId));
  res.json({ ok: true });
});

const PatchThreadBody = z.object({
  title: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
});

router.patch("/chat/threads/:threadId", async (req, res): Promise<void> => {
  const parsed = PatchThreadBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.pinned !== undefined) {
    updates.pinned = parsed.data.pinned;
    updates.pinnedAt = parsed.data.pinned ? new Date() : null;
  }

  const [updated] = await personalDb.update(chatThreadsTable)
    .set(updates)
    .where(eq(chatThreadsTable.id, req.params.threadId))
    .returning();

  if (!updated) { res.status(404).json({ error: "Thread not found" }); return; }
  res.json(updated);
});

router.get("/chat/threads/:threadId/messages", async (req, res): Promise<void> => {
  const messages = await personalDb.select().from(chatMessagesTable)
    .where(eq(chatMessagesTable.threadId, req.params.threadId))
    .orderBy(chatMessagesTable.createdAt);
  res.json(messages);
});

const SendMessageBody = z.object({
  content: z.string().min(1),
  mentionedAgent: z.string().optional(),
});

router.post("/chat/threads/:threadId/messages", async (req, res): Promise<void> => {
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { threadId } = req.params;
  const { content, mentionedAgent } = parsed.data;

  const [thread] = await personalDb.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId)).limit(1);
  if (!thread) { res.status(404).json({ error: "Thread not found" }); return; }

  await personalDb.insert(chatMessagesTable).values({ threadId, role: "user", content });

  const userMessages = await personalDb.select({ id: chatMessagesTable.id }).from(chatMessagesTable)
    .where(and(eq(chatMessagesTable.threadId, threadId), eq(chatMessagesTable.role, "user")));
  if (userMessages.length <= 1 && !thread.title) {
    autoTitle(threadId, content);
  }

  const history = await personalDb.select().from(chatMessagesTable)
    .where(eq(chatMessagesTable.threadId, threadId))
    .orderBy(chatMessagesTable.createdAt);

  const messages: Parameters<typeof anthropic.messages.create>[0]["messages"] = history.map(m => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let systemPrompt = await buildSystemPrompt(thread.contextType || undefined, thread.contextId || undefined);
  if (mentionedAgent) {
    const SPECIALISTS = new Set(["orchestrator", "email", "tasks", "ideas", "contacts", "schedule", "calls", "brief", "checkin", "journal", "ingest", "coach"]);
    const INTEGRATION_HINTS: Record<string, string> = {
      slack: "Slack tools (send_slack_message, read_slack_channel, list_slack_channels, search_slack)",
      linear: "Linear tools (create_linear_issue, get_linear_members)",
      drive: "Google Drive tools (read_google_sheet, read_google_doc, search_google_drive)",
      web: "Web tools (web_search, browse_url)",
      database: "Database tools (query_database, get_business_context, get_communication_log)",
    };
    if (SPECIALISTS.has(mentionedAgent)) {
      systemPrompt += `\n\nSPECIALIST HINT: Tony tagged @${mentionedAgent}. Prioritize using that specialist's tools for this request. If you determine a different specialist is actually more appropriate, before acting, ask Tony to confirm: "I think this is better handled by @<other>. Want me to use that instead?"`;
    } else if (INTEGRATION_HINTS[mentionedAgent]) {
      systemPrompt += `\n\nINTEGRATION HINT: Tony tagged @${mentionedAgent}. Prefer ${INTEGRATION_HINTS[mentionedAgent]} for this request. If a specialist would handle it better, before acting, ask Tony: "This looks like a job for the <X> specialist — want to use that instead of the raw ${mentionedAgent} tools?"`;
    } else {
      systemPrompt += `\n\nHINT: Tony tagged @${mentionedAgent}. Use related tools and confirm with Tony if a different approach would work better.`;
    }
  }
  let fullResponse = "";
  const toolResults: { name: string; result: string }[] = [];
  const streamStartTime = Date.now();

  try {
    for (let turn = 0; turn < 5; turn++) {
      // createTrackedStream resolves provider/model from the 'medium' tier
      // (chat_thread is mapped there in feature-tiers.ts). Each turn writes
      // its own ai_usage_logs row via the wrapper's onFinish hook.
      const stream = await createTrackedStream("chat_thread", {
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      });

      let turnText = "";
      const toolUseBlocks: { id: string; name: string; input: Record<string, unknown> }[] = [];
      const announcedTools = new Set<string>();

      // Vercel AI SDK fullStream emits unified events across providers.
      for await (const event of stream.fullStream) {
        switch (event.type) {
          case "text-delta": {
            const delta = (event as any).text ?? "";
            turnText += delta;
            res.write(`data: ${JSON.stringify({ type: "text", text: delta })}\n\n`);
            break;
          }
          case "tool-input-start": {
            const id = (event as any).id;
            const name = (event as any).toolName ?? (event as any).name;
            if (id && !announcedTools.has(id)) {
              announcedTools.add(id);
              res.write(`data: ${JSON.stringify({ type: "tool_start", tool: name })}\n\n`);
            }
            break;
          }
          case "tool-call": {
            const e = event as any;
            toolUseBlocks.push({
              id: e.toolCallId,
              name: e.toolName,
              input: (e.input ?? {}) as Record<string, unknown>,
            });
            // Announce if not already (some providers skip tool-input-start).
            if (!announcedTools.has(e.toolCallId)) {
              announcedTools.add(e.toolCallId);
              res.write(`data: ${JSON.stringify({ type: "tool_start", tool: e.toolName })}\n\n`);
            }
            break;
          }
          case "error": {
            const e = event as any;
            console.warn("[chat-threads] stream error:", e.error);
            break;
          }
          // Other events (start, finish, finish-step, text-start, text-end,
          // tool-input-delta, tool-input-end) are not user-visible — ignore.
          default:
            break;
        }
      }

      if (turnText) fullResponse += turnText;
      if (toolUseBlocks.length === 0) break;

      const assistantContent: any[] = [];
      if (turnText) assistantContent.push({ type: "text", text: turnText });
      for (const tb of toolUseBlocks) {
        assistantContent.push({ type: "tool_use", id: tb.id, name: tb.name, input: tb.input });
      }
      messages.push({ role: "assistant", content: assistantContent });

      const toolResultContent: any[] = [];
      for (const tb of toolUseBlocks) {
        const result = await executeTool(tb.name, tb.input);
        toolResults.push({ name: tb.name, result });
        toolResultContent.push({ type: "tool_result", tool_use_id: tb.id, content: result });
        res.write(`data: ${JSON.stringify({ type: "tool_result", tool: tb.name, result: result.substring(0, 200) })}\n\n`);
      }
      messages.push({ role: "user", content: toolResultContent });
    }

    // Stream usage is logged per-turn by createTrackedStream's onFinish callback.
    void streamStartTime;

    await personalDb.insert(chatMessagesTable).values({
      threadId,
      role: "assistant",
      content: fullResponse,
      toolCalls: toolResults.length > 0 ? toolResults : undefined,
    });

    await personalDb.update(chatThreadsTable).set({ updatedAt: new Date() }).where(eq(chatThreadsTable.id, threadId));

    res.write(`data: ${JSON.stringify({ type: "done", toolResults })}\n\n`);
    res.end();
  } catch (err) {
    console.error("[chat-threads] Error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", error: "Claude API error" })}\n\n`);
    res.end();
  }
});

export default router;
