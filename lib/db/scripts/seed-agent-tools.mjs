// Seed agent_tools registry. Tool input_schema + handler_path live here
// (architecture .md files describe intent; this file describes wire format).
// Idempotent: upsert by tool_name.
//
// Run: node --env-file=.env lib/db/scripts/seed-agent-tools.mjs

import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL && !process.env.SUPABASE_DATABASE_URL) {
  console.error("[seed-agent-tools] DATABASE_URL not set");
  process.exit(1);
}

const pool = process.env.SUPABASE_DATABASE_URL
  ? (() => {
      const parsed = new URL(process.env.SUPABASE_DATABASE_URL);
      return new Pool({
        host: parsed.hostname,
        port: Number(parsed.port) || 5432,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, ""),
        ssl: { rejectUnauthorized: false },
      });
    })()
  : new Pool({ connectionString: process.env.DATABASE_URL });

// ── Tool registry ────────────────────────────────────────────────────────────
// handler_path is relative to artifacts/api-server/src/agents/tools/
// (no leading ./, no .ts/.js extension — runtime appends .js for ESM resolution).

const TOOLS = [
  // ── Coach tools ──
  {
    tool_name: "read_agent_files",
    agent: "coach",
    description: "Load every memory entry (SOUL/USER/AGENTS/IDENTITY/TOOLS/SKILLS/MEMORY) for one specialist. Wide read — used by Coach to see the full agent state before proposing changes.",
    handler_path: "coach/read_agent_files",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name (e.g. 'email', 'tasks')" },
      },
      required: ["agent"],
    },
  },
  {
    tool_name: "read_feedback",
    agent: "coach",
    description: "Load specific feedback rows by ID. Used to fetch the batch Tony selected when clicking Train.",
    handler_path: "coach/read_feedback",
    input_schema: {
      type: "object",
      properties: {
        feedback_ids: {
          type: "array",
          items: { type: "string" },
          description: "Feedback row UUIDs",
        },
      },
      required: ["feedback_ids"],
    },
  },
  {
    tool_name: "read_recent_feedback",
    agent: "coach",
    description: "Load recent feedback rows for an agent — broader context beyond the selected batch.",
    handler_path: "coach/read_recent_feedback",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        limit: { type: "number", description: "Max rows (default 50, max 200)" },
      },
      required: ["agent"],
    },
  },
  {
    tool_name: "read_recent_proposals",
    agent: "coach",
    description: "Load recent memory proposals for an agent with their status (pending/approved/rejected) + Tony's rejection_reason + the diffs payload. CALL THIS BEFORE submit_proposal so you don't re-propose what Tony already rejected — read the recent rejections and either skip the topic or address the stated reason in the new proposal. Filter by status='rejected' to see only past rejections.",
    handler_path: "coach/read_recent_proposals",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        limit: { type: "number", description: "Max rows (default 10, max 50)" },
        status: { type: "string", enum: ["pending", "approved", "rejected", "all"], description: "Filter (default all)" },
      },
      required: ["agent"],
    },
  },
  {
    tool_name: "read_run_history",
    agent: "coach",
    description: "Load recent runs of a specialist's skill (cost, latency, errors). Used when reasoning about whether a feedback issue is a memory gap vs a brittle skill body.",
    handler_path: "coach/read_run_history",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        skill: { type: "string" },
        limit: { type: "number", description: "Max rows (default 20, max 100)" },
      },
      required: ["agent", "skill"],
    },
  },
  {
    tool_name: "submit_proposal",
    agent: "coach",
    description: "Submit ONE proposal bundling N memory-section diffs. Tony approves/rejects atomically. Coach may call this AT MOST ONCE per training run.",
    handler_path: "coach/submit_proposal",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Target specialist (e.g. 'email')" },
        reason: { type: "string", description: "One-line summary of the change. Reference evidence count + pattern." },
        diffs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              section_name: { type: "string", description: "Memory section slug (e.g. 'tone-preferences')" },
              kind: { type: "string", enum: ["memory"], description: "Must be 'memory' — Coach cannot edit other kinds" },
              before: { type: "string", description: "Existing content verbatim (or '' if section is new)" },
              after: { type: "string", description: "Proposed new content in full" },
            },
            required: ["section_name", "kind", "before", "after"],
          },
        },
        feedback_ids: {
          type: "array",
          items: { type: "string" },
          description: "Subset of input feedback rows that drove this proposal",
        },
      },
      required: ["agent", "reason", "diffs", "feedback_ids"],
    },
  },
  {
    tool_name: "append_to_evaluation_log",
    agent: "coach",
    description: "Append a one-paragraph note to coach/evaluation-log. Used when Coach decides a run produces no proposal, or to record lessons from rejected proposals.",
    handler_path: "coach/append_to_evaluation_log",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The TARGET agent the note is about (the log lives at agent='coach')" },
        note: { type: "string", description: "One paragraph max" },
      },
      required: ["agent", "note"],
    },
  },
  {
    tool_name: "append_to_examples",
    agent: "coach",
    description: "Append a few-shot example to a specialist's examples-<skill>.md memory section. Only fires when the target skill has auto_examples=true.",
    handler_path: "coach/append_to_examples",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        skill: { type: "string" },
        example: {
          type: "object",
          properties: {
            input: { type: "string" },
            output: { type: "string" },
            why_good: { type: "string" },
          },
          required: ["input", "output"],
        },
      },
      required: ["agent", "skill", "example"],
    },
  },

  // ── Orchestrator (AI Chat) tools — 42 wrappers around legacy claude.ts handlers ──
  // Schemas + descriptions copied verbatim from artifacts/api-server/src/routes/tcc/claude.ts
  // TOOLS array (lines 18–516). web_search + browse_url are Anthropic-native.
  {
    tool_name: "send_slack_message",
    agent: "orchestrator",
    description: "Post a message to a FlipIQ Slack channel. Use for team notifications, tech ideas, and deal alerts.",
    handler_path: "orchestrator/send_slack_message",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel name, e.g. #tech-ideas, #sales, #general" },
        message: { type: "string", description: "The message text to post" },
      },
      required: ["channel", "message"],
    },
  },
  {
    tool_name: "create_linear_issue",
    agent: "orchestrator",
    description: "Create a Linear issue for a tech task or bug. Use for actionable tech ideas and engineering tasks. Call get_linear_members first if you need to assign to a specific person.",
    handler_path: "orchestrator/create_linear_issue",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, clear issue title" },
        description: { type: "string", description: "Full description of the task or bug" },
        priority: { type: "number", description: "Priority: 1=urgent, 2=high, 3=medium, 4=low" },
        assignee_id: { type: "string", description: "Linear user ID to assign this issue to (get from get_linear_members)" },
      },
      required: ["title", "description"],
    },
  },
  {
    tool_name: "get_linear_members",
    agent: "orchestrator",
    description: "List all active Linear team members with their user IDs, names, and emails. Use this before assigning a Linear issue to get the correct user ID.",
    handler_path: "orchestrator/get_linear_members",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    tool_name: "send_email",
    agent: "orchestrator",
    description: "Send an email on Tony's behalf via Gmail from tony@flipiq.com. Use for follow-ups, EOD reports, or outreach.",
    handler_path: "orchestrator/send_email",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Full email body text" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    tool_name: "get_email_brain",
    agent: "orchestrator",
    description: "Retrieve Tony's learned email priority rules (the brain compiled from his thumbs up/down training).",
    handler_path: "orchestrator/get_email_brain",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    tool_name: "list_recent_emails",
    agent: "orchestrator",
    description: "Fetch Tony's most recent unread Gmail messages. Use to check inbox, triage emails, or get context before drafting a reply.",
    handler_path: "orchestrator/list_recent_emails",
    input_schema: {
      type: "object",
      properties: {
        max_results: { type: "number", description: "How many emails to fetch (default 5, max 10)" },
      },
      required: [],
    },
  },
  {
    tool_name: "draft_gmail_reply",
    agent: "orchestrator",
    description: "Create a Gmail draft reply to an email. Tony will review and send manually. Use when asked to draft or prepare a reply.",
    handler_path: "orchestrator/draft_gmail_reply",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject (add 'Re: ' prefix for replies)" },
        body: { type: "string", description: "Full email body text" },
        thread_id: { type: "string", description: "Gmail thread ID to reply to (optional)" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    tool_name: "read_slack_channel",
    agent: "orchestrator",
    description: "Read recent messages from a FlipIQ Slack channel. Use to check what the team has been discussing, get deal updates, or see sales activity.",
    handler_path: "orchestrator/read_slack_channel",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Slack channel name or ID, e.g. #general, #sales, #tech-ideas" },
        limit: { type: "number", description: "Number of messages to fetch (default 10, max 50)" },
      },
      required: ["channel"],
    },
  },
  {
    tool_name: "list_slack_channels",
    agent: "orchestrator",
    description: "List all Slack channels Tony's workspace has. Use to discover which channels exist before reading or posting.",
    handler_path: "orchestrator/list_slack_channels",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    tool_name: "search_slack",
    agent: "orchestrator",
    description: "Search Slack messages across all channels. Use to find specific conversations, deal mentions, or team updates.",
    handler_path: "orchestrator/search_slack",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, e.g. 'deal closed', 'Fernando Perez', 'demo scheduled'" },
      },
      required: ["query"],
    },
  },
  {
    tool_name: "get_today_calendar",
    agent: "orchestrator",
    description: "Fetch Tony's Google Calendar events for today. Use to check his schedule, find meeting times, or give him a schedule overview.",
    handler_path: "orchestrator/get_today_calendar",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    tool_name: "create_calendar_event",
    agent: "orchestrator",
    description: "Create a new event on Tony's Google Calendar. SCOPE GATEKEEPER: Only create events for sales calls, prospect meetings, or Ramy support. Warn if purpose is unclear.",
    handler_path: "orchestrator/create_calendar_event",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        description: { type: "string", description: "Event notes or agenda" },
        start: { type: "string", description: "ISO 8601 datetime string, e.g. 2026-04-04T10:00:00-07:00" },
        end: { type: "string", description: "ISO 8601 datetime string, e.g. 2026-04-04T11:00:00-07:00" },
        attendees: { type: "array", items: { type: "string" }, description: "List of attendee email addresses" },
        purpose: { type: "string", description: "Purpose: 'sales', 'ramy_support', or 'other'" },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    tool_name: "get_meeting_history",
    agent: "orchestrator",
    description: "Retrieve past meeting notes and context for a specific contact. Use before a follow-up call or meeting to recall what was discussed previously.",
    handler_path: "orchestrator/get_meeting_history",
    input_schema: {
      type: "object",
      properties: {
        contact_name: { type: "string", description: "Name of the contact to look up meeting history for" },
        limit: { type: "number", description: "Max number of meetings to return (default 5)" },
      },
      required: ["contact_name"],
    },
  },
  {
    tool_name: "log_meeting_context",
    agent: "orchestrator",
    description: "Save the context and outcomes of a meeting or call. Use after a meeting to record what was discussed, next steps, and deal outcome.",
    handler_path: "orchestrator/log_meeting_context",
    input_schema: {
      type: "object",
      properties: {
        contact_name: { type: "string", description: "Name of the contact you met with" },
        date: { type: "string", description: "Date of the meeting in YYYY-MM-DD format" },
        summary: { type: "string", description: "What was discussed in the meeting" },
        next_steps: { type: "string", description: "Agreed next actions and follow-up items" },
        outcome: { type: "string", description: "Result of the meeting (e.g. 'demo scheduled', 'not interested', 'send proposal')" },
      },
      required: ["contact_name", "date", "summary"],
    },
  },
  {
    tool_name: "analyze_transcript",
    agent: "orchestrator",
    description: "Analyze a meeting or call transcript to extract key decisions, action items, contact mentions, and follow-up tasks. Use when Tony pastes in a Plaud or other recording transcript.",
    handler_path: "orchestrator/analyze_transcript",
    input_schema: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "The full text transcript to analyze" },
        context: { type: "string", description: "Optional: who was on the call, what the call was about" },
      },
      required: ["transcript"],
    },
  },
  {
    tool_name: "send_eod_report",
    agent: "orchestrator",
    description: "Generate and send today's End of Day (EOD) report. Sends Tony's performance summary to tony@flipiq.com and Ethan's accountability brief to ethan@flipiq.com. Will not double-send if already sent today.",
    handler_path: "orchestrator/send_eod_report",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    tool_name: "create_task",
    agent: "orchestrator",
    description: "Create a new task (Linear issue) for Tony's team. Use for actionable items that need tracking. Call get_linear_members first if you need to assign to a specific person.",
    handler_path: "orchestrator/create_task",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, clear task title" },
        description: { type: "string", description: "Full description of the task" },
        priority: { type: "number", description: "Priority: 1=urgent, 2=high, 3=medium, 4=low" },
        assignee_id: { type: "string", description: "Linear user ID to assign this task to (get from get_linear_members)" },
      },
      required: ["title"],
    },
  },
  {
    tool_name: "get_contact_brief",
    agent: "orchestrator",
    description: "Get a quick AI-generated brief on a contact: history, pipeline stage, AI score, last communication. Use before a sales call.",
    handler_path: "orchestrator/get_contact_brief",
    input_schema: {
      type: "object",
      properties: {
        contact_name: { type: "string", description: "Name of the contact to look up" },
        contact_id: { type: "string", description: "UUID of the contact (optional, more precise)" },
      },
      required: [],
    },
  },
  {
    tool_name: "update_contact_stage",
    agent: "orchestrator",
    description: "Update a contact's sales pipeline stage. Valid stages: new, outreach, engaged, meeting_scheduled, negotiating, closed, dormant.",
    handler_path: "orchestrator/update_contact_stage",
    input_schema: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "UUID of the contact" },
        stage: { type: "string", description: "New stage: new, outreach, engaged, meeting_scheduled, negotiating, closed, dormant" },
      },
      required: ["contact_id", "stage"],
    },
  },
  {
    tool_name: "search_contacts",
    agent: "orchestrator",
    description: "Search Tony's contact database by name, company, or type. Use to find prospects or look up contact details.",
    handler_path: "orchestrator/search_contacts",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (name, company, or type)" },
        limit: { type: "number", description: "Max results to return (default 5, max 20)" },
      },
      required: ["query"],
    },
  },
  {
    tool_name: "list_all_contacts",
    agent: "orchestrator",
    description: "List every contact in the database (id + name + company only). Use as a fuzzy-lookup fallback when search_contacts returns 0 hits — read the full namespace and propose the closest matches back to Tony as a clarification question (e.g. 'You said Tony — did you mean Tony Diaz or Tony Romero?'). Token-cheap; for richer info call search_contacts on the chosen name.",
    handler_path: "orchestrator/list_all_contacts",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    tool_name: "schedule_meeting",
    agent: "orchestrator",
    description: "Schedule a sales meeting or call on Tony's Google Calendar. SCOPE GATEKEEPER: Only for sales calls, prospect meetings, or Ramy support. Morning Protection: no external meetings before noon PT.",
    handler_path: "orchestrator/schedule_meeting",
    input_schema: {
      type: "object",
      properties: {
        contactName: { type: "string", description: "Name of the contact to meet with" },
        contactEmail: { type: "string", description: "Email address of the contact (for calendar invite)" },
        purpose: { type: "string", description: "Purpose: 'sales', 'ramy_support', or 'other'" },
        duration: { type: "number", description: "Duration in minutes (default 30)" },
        preferredDate: { type: "string", description: "ISO 8601 datetime string, e.g. 2026-04-04T14:00:00-07:00" },
      },
      required: ["contactName", "preferredDate"],
    },
  },
  {
    tool_name: "research_contact",
    agent: "orchestrator",
    description: "Deep-research a contact: AI score, stage, personality notes, last 5 interactions from communication log. Use before a sales call to prepare.",
    handler_path: "orchestrator/research_contact",
    input_schema: {
      type: "object",
      properties: {
        contactName: { type: "string", description: "Name of the contact to research" },
        contactId: { type: "string", description: "UUID of the contact (optional, more precise)" },
      },
      required: [],
    },
  },
  {
    tool_name: "web_search",
    agent: "orchestrator",
    description: "Search the internet. Use for company research, news, market data, or anything not in the app database.",
    handler_path: "orchestrator/web_search",
    is_native: 1,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    tool_name: "browse_url",
    agent: "orchestrator",
    description: "Fetch and read the text content of any webpage URL. Use to read articles, company websites, or any link Tony mentions.",
    handler_path: "orchestrator/browse_url",
    is_native: 1,
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to fetch, including https://" },
      },
      required: ["url"],
    },
  },
  {
    tool_name: "query_database",
    agent: "orchestrator",
    description: "Run a read-only SQL SELECT query on Tony's PostgreSQL database. Gives full access to all tables: contacts, communication_log, contact_intelligence, business_context, meeting_history, tcc_checkins, journals, chat_messages, etc. Only SELECT is allowed.",
    handler_path: "orchestrator/query_database",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A valid SQL SELECT statement" },
      },
      required: ["sql"],
    },
  },
  {
    tool_name: "read_google_sheet",
    agent: "orchestrator",
    description: "Read rows from a Google Sheet. Use to pull data Tony has stored in spreadsheets.",
    handler_path: "orchestrator/read_google_sheet",
    input_schema: {
      type: "object",
      properties: {
        sheet_id: { type: "string", description: "The Google Sheet ID (from the URL)" },
        tab_name: { type: "string", description: "The tab/sheet name, e.g. 'Sheet1' or 'Contacts'" },
        range: { type: "string", description: "Optional A1 range, e.g. 'A1:Z100'. Defaults to entire tab." },
      },
      required: ["sheet_id", "tab_name"],
    },
  },
  {
    tool_name: "read_google_doc",
    agent: "orchestrator",
    description: "Read the full text content of a Google Doc by its document ID.",
    handler_path: "orchestrator/read_google_doc",
    input_schema: {
      type: "object",
      properties: {
        doc_id: { type: "string", description: "The Google Doc ID (from the URL)" },
      },
      required: ["doc_id"],
    },
  },
  {
    tool_name: "search_google_drive",
    agent: "orchestrator",
    description: "Search Google Drive for files by name or content. Returns file names, types, IDs, and last modified dates.",
    handler_path: "orchestrator/search_google_drive",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Drive search query, e.g. 'proposal', 'contract 2026', 'FlipIQ'" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    tool_name: "get_business_context",
    agent: "orchestrator",
    description: "Fetch all stored business context: business plan, 90-day plan, and any other documents in the business_context table.",
    handler_path: "orchestrator/get_business_context",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    tool_name: "get_all_tasks",
    agent: "orchestrator",
    description: "Fetch all open Linear tasks/issues with status, priority, assignee, and due dates.",
    handler_path: "orchestrator/get_all_tasks",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    tool_name: "get_communication_log",
    agent: "orchestrator",
    description: "Fetch recent entries from Tony's communication log (emails, calls, texts logged). Optionally filter by contact name or channel.",
    handler_path: "orchestrator/get_communication_log",
    input_schema: {
      type: "object",
      properties: {
        contact_name: { type: "string", description: "Filter by contact name (optional)" },
        channel: { type: "string", description: "Filter by channel: email, call, sms, slack (optional)" },
        limit: { type: "number", description: "Max results to return (default 20)" },
      },
      required: [],
    },
  },
  {
    tool_name: "get_daily_checkin_history",
    agent: "orchestrator",
    description: "Fetch Tony's recent daily check-in history: sleep hours, Bible reading, bedtime, exercise, mood, and top priorities.",
    handler_path: "orchestrator/get_daily_checkin_history",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of recent check-ins to fetch (default 7)" },
      },
      required: [],
    },
  },
  {
    tool_name: "read_email_thread",
    agent: "orchestrator",
    description: "Read a full Gmail email thread by thread ID. Returns all messages in the thread with from, to, date, subject, and body.",
    handler_path: "orchestrator/read_email_thread",
    input_schema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "Gmail thread ID" },
      },
      required: ["thread_id"],
    },
  },
  {
    tool_name: "search_emails",
    agent: "orchestrator",
    description: "Search Tony's Gmail with any query (same format as Gmail search bar). Returns from, subject, date, snippet for each match. Examples: 'from:john subject:proposal', 'newer_than:3d FlipIQ', 'Fernando'.",
    handler_path: "orchestrator/search_emails",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query" },
        limit: { type: "number", description: "Max results to return (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    tool_name: "read_email_message",
    agent: "orchestrator",
    description: "Read a single Gmail message by message ID. Returns full from, to, cc, date, subject, and body text.",
    handler_path: "orchestrator/read_email_message",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Gmail message ID" },
      },
      required: ["message_id"],
    },
  },
  {
    tool_name: "get_calendar_range",
    agent: "orchestrator",
    description: "Fetch Google Calendar events for any date range. Use to see Tony's schedule for a specific week, day, or period.",
    handler_path: "orchestrator/get_calendar_range",
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date as ISO string, e.g. '2026-04-07' or '2026-04-07T00:00:00-07:00'" },
        end_date: { type: "string", description: "End date as ISO string, e.g. '2026-04-11' or '2026-04-11T23:59:59-07:00'" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    tool_name: "create_calendar_reminder",
    agent: "orchestrator",
    description: "Create a quick personal calendar reminder for Tony (no attendees, no scope gatekeeper). Use for personal reminders like 'call Fernando back at 3pm' or 'pick up prescription'.",
    handler_path: "orchestrator/create_calendar_reminder",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Reminder title" },
        datetime: { type: "string", description: "ISO 8601 datetime string, e.g. 2026-04-05T15:00:00-07:00" },
        notes: { type: "string", description: "Optional notes for the reminder" },
      },
      required: ["title", "datetime"],
    },
  },
  {
    tool_name: "update_calendar_event",
    agent: "orchestrator",
    description: "Update an existing Google Calendar event. Can change title, description, start/end time, location, or attendees.",
    handler_path: "orchestrator/update_calendar_event",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Google Calendar event ID" },
        summary: { type: "string", description: "New event title (optional)" },
        description: { type: "string", description: "New event description (optional)" },
        start: { type: "string", description: "New start datetime ISO string (optional)" },
        end: { type: "string", description: "New end datetime ISO string (optional)" },
        location: { type: "string", description: "New location (optional)" },
      },
      required: ["event_id"],
    },
  },
  {
    tool_name: "delete_calendar_event",
    agent: "orchestrator",
    description: "Delete or cancel a Google Calendar event by event ID.",
    handler_path: "orchestrator/delete_calendar_event",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Google Calendar event ID to delete" },
      },
      required: ["event_id"],
    },
  },
  {
    tool_name: "get_411_plan",
    agent: "orchestrator",
    description: "Get FlipIQ's full 411 goal cascade: 5-year → 1-year → quarterly → monthly → weekly goals. Shows who owns each goal and current status. Use to answer questions about company direction, priorities, and accountability.",
    handler_path: "orchestrator/get_411_plan",
    input_schema: {
      type: "object",
      properties: {
        horizon: { type: "string", description: "Filter to a specific horizon: 5yr, 1yr, quarterly, monthly, weekly, daily (optional — omit for all)" },
        owner: { type: "string", description: "Filter by team member name (optional)" },
        status: { type: "string", description: "Filter by status: active, done, paused (optional)" },
      },
      required: [],
    },
  },
  {
    tool_name: "get_team_roster",
    agent: "orchestrator",
    description: "Get FlipIQ's full team roster: each person's role, responsibilities, current focus, and Slack/email info. Use when routing tasks, assigning issues, or understanding who owns what.",
    handler_path: "orchestrator/get_team_roster",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    tool_name: "update_goal_status",
    agent: "orchestrator",
    description: "Mark a company goal as done, active, or paused. Can also reassign the owner or change the due date. Use when Tony completes a goal or wants to update accountability.",
    handler_path: "orchestrator/update_goal_status",
    input_schema: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "UUID of the goal to update" },
        status: { type: "string", description: "New status: active, done, paused" },
        owner: { type: "string", description: "New owner name (optional)" },
        due_date: { type: "string", description: "New due date in YYYY-MM-DD format (optional)" },
      },
      required: ["goal_id"],
    },
  },
];

// ── Run ──────────────────────────────────────────────────────────────────────
async function main() {
  let inserted = 0, updated = 0;

  for (const t of TOOLS) {
    const r = await pool.query(
      `INSERT INTO agent_tools (tool_name, agent, description, input_schema, handler_path, is_native, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
       ON CONFLICT (tool_name)
       DO UPDATE SET
         agent        = EXCLUDED.agent,
         description  = EXCLUDED.description,
         input_schema = EXCLUDED.input_schema,
         handler_path = EXCLUDED.handler_path,
         is_native    = EXCLUDED.is_native,
         updated_at   = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        t.tool_name,
        t.agent ?? null,
        t.description ?? null,
        JSON.stringify(t.input_schema),
        t.handler_path,
        t.is_native ?? 0,
      ]
    );
    if (r.rows[0].inserted) inserted++; else updated++;
  }

  console.log(`[seed-agent-tools] ${TOOLS.length} tools: +${inserted} new, ~${updated} updated`);

  const { rows } = await pool.query(
    `SELECT agent, count(*)::int AS n
       FROM agent_tools
       GROUP BY agent
       ORDER BY agent NULLS FIRST`
  );
  console.log("\n[seed-agent-tools] tools by agent:");
  for (const r of rows) console.log(`  ${(r.agent ?? "(shared)").padEnd(15)} ${r.n}`);

  await pool.end();
}

main().catch(err => {
  console.error("[seed-agent-tools] failed:", err);
  pool.end();
  process.exit(1);
});
