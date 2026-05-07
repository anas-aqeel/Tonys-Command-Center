// Static tool-handler registry — bundle-safe.
//
// Why this exists: the runtime previously called `import("./<handler_path>.js")`
// at request-time. That works in dev with TS source files on disk, but fails
// inside esbuild's bundled dist/index.mjs because the relative paths don't
// resolve in the single-file bundle.
//
// This file statically imports every tool wrapper at build time, so esbuild
// can include them all in the bundle. resolveTool() consults this Map first
// (always wins) and only falls back to dynamic import for tools that aren't
// listed here (e.g., future tools added without rebuilding this file).
//
// When you add a new tool wrapper:
//   1. Create the file under tools/<agent>/<name>.ts with default-export ToolHandler
//   2. Add the import + Map entry below
//   3. Run the seed: node --env-file=.env lib/db/scripts/seed-agent-tools.mjs

import type { ToolHandler } from "./index.js";

// ─── Coach (7) ────────────────────────────────────────────────────────────────
import readAgentFiles from "./coach/read_agent_files.js";
import readFeedback from "./coach/read_feedback.js";
import readRecentFeedback from "./coach/read_recent_feedback.js";
import readRunHistory from "./coach/read_run_history.js";
import submitProposal from "./coach/submit_proposal.js";
import appendToEvaluationLog from "./coach/append_to_evaluation_log.js";
import appendToExamples from "./coach/append_to_examples.js";

// ─── Orchestrator: Slack (4) ──────────────────────────────────────────────────
import sendSlackMessage from "./orchestrator/send_slack_message.js";
import readSlackChannel from "./orchestrator/read_slack_channel.js";
import listSlackChannels from "./orchestrator/list_slack_channels.js";
import searchSlack from "./orchestrator/search_slack.js";

// ─── Orchestrator: Linear (3) ─────────────────────────────────────────────────
import createLinearIssue from "./orchestrator/create_linear_issue.js";
import createTask from "./orchestrator/create_task.js";
import getLinearMembers from "./orchestrator/get_linear_members.js";

// ─── Orchestrator: Email/Gmail (7) ────────────────────────────────────────────
import sendEmail from "./orchestrator/send_email.js";
import getEmailBrain from "./orchestrator/get_email_brain.js";
import listRecentEmails from "./orchestrator/list_recent_emails.js";
import draftGmailReply from "./orchestrator/draft_gmail_reply.js";
import searchEmails from "./orchestrator/search_emails.js";
import readEmailThread from "./orchestrator/read_email_thread.js";
import readEmailMessage from "./orchestrator/read_email_message.js";

// ─── Orchestrator: Calendar (7) ───────────────────────────────────────────────
import getTodayCalendar from "./orchestrator/get_today_calendar.js";
import createCalendarEvent from "./orchestrator/create_calendar_event.js";
import scheduleMeeting from "./orchestrator/schedule_meeting.js";
import getCalendarRange from "./orchestrator/get_calendar_range.js";
import createCalendarReminder from "./orchestrator/create_calendar_reminder.js";
import updateCalendarEvent from "./orchestrator/update_calendar_event.js";
import deleteCalendarEvent from "./orchestrator/delete_calendar_event.js";

// ─── Orchestrator: Contacts (6) ───────────────────────────────────────────────
import getContactBrief from "./orchestrator/get_contact_brief.js";
import updateContactStage from "./orchestrator/update_contact_stage.js";
import searchContacts from "./orchestrator/search_contacts.js";
import listAllContacts from "./orchestrator/list_all_contacts.js";
import researchContact from "./orchestrator/research_contact.js";
import getCommunicationLog from "./orchestrator/get_communication_log.js";

// ─── Orchestrator: Meetings (3) ───────────────────────────────────────────────
import getMeetingHistory from "./orchestrator/get_meeting_history.js";
import logMeetingContext from "./orchestrator/log_meeting_context.js";
import analyzeTranscript from "./orchestrator/analyze_transcript.js";

// ─── Orchestrator: Tasks (1) ──────────────────────────────────────────────────
import getAllTasks from "./orchestrator/get_all_tasks.js";

// ─── Orchestrator: Drive (3) ──────────────────────────────────────────────────
import readGoogleSheet from "./orchestrator/read_google_sheet.js";
import readGoogleDoc from "./orchestrator/read_google_doc.js";
import searchGoogleDrive from "./orchestrator/search_google_drive.js";

// ─── Orchestrator: Business (4) ───────────────────────────────────────────────
import getBusinessContext from "./orchestrator/get_business_context.js";
import getDailyCheckinHistory from "./orchestrator/get_daily_checkin_history.js";
import get411Plan from "./orchestrator/get_411_plan.js";
import getTeamRoster from "./orchestrator/get_team_roster.js";

// ─── Orchestrator: Goals (1) ──────────────────────────────────────────────────
import updateGoalStatus from "./orchestrator/update_goal_status.js";

// ─── Orchestrator: Web (2) — native, never executed locally ───────────────────
import webSearch from "./orchestrator/web_search.js";
import browseUrl from "./orchestrator/browse_url.js";

// ─── Orchestrator: DB (1) ─────────────────────────────────────────────────────
import queryDatabase from "./orchestrator/query_database.js";

// ─── Orchestrator: Reports (1) ────────────────────────────────────────────────
import sendEodReport from "./orchestrator/send_eod_report.js";

// Map handler_path (DB column) → ToolHandler. The keys must match the
// `handler_path` field in agent_tools rows exactly.
export const HANDLER_REGISTRY: Map<string, ToolHandler> = new Map([
  // Coach
  ["coach/read_agent_files", readAgentFiles],
  ["coach/read_feedback", readFeedback],
  ["coach/read_recent_feedback", readRecentFeedback],
  ["coach/read_run_history", readRunHistory],
  ["coach/submit_proposal", submitProposal],
  ["coach/append_to_evaluation_log", appendToEvaluationLog],
  ["coach/append_to_examples", appendToExamples],

  // Orchestrator — Slack
  ["orchestrator/send_slack_message", sendSlackMessage],
  ["orchestrator/read_slack_channel", readSlackChannel],
  ["orchestrator/list_slack_channels", listSlackChannels],
  ["orchestrator/search_slack", searchSlack],

  // Orchestrator — Linear
  ["orchestrator/create_linear_issue", createLinearIssue],
  ["orchestrator/create_task", createTask],
  ["orchestrator/get_linear_members", getLinearMembers],

  // Orchestrator — Email / Gmail
  ["orchestrator/send_email", sendEmail],
  ["orchestrator/get_email_brain", getEmailBrain],
  ["orchestrator/list_recent_emails", listRecentEmails],
  ["orchestrator/draft_gmail_reply", draftGmailReply],
  ["orchestrator/search_emails", searchEmails],
  ["orchestrator/read_email_thread", readEmailThread],
  ["orchestrator/read_email_message", readEmailMessage],

  // Orchestrator — Calendar
  ["orchestrator/get_today_calendar", getTodayCalendar],
  ["orchestrator/create_calendar_event", createCalendarEvent],
  ["orchestrator/schedule_meeting", scheduleMeeting],
  ["orchestrator/get_calendar_range", getCalendarRange],
  ["orchestrator/create_calendar_reminder", createCalendarReminder],
  ["orchestrator/update_calendar_event", updateCalendarEvent],
  ["orchestrator/delete_calendar_event", deleteCalendarEvent],

  // Orchestrator — Contacts
  ["orchestrator/get_contact_brief", getContactBrief],
  ["orchestrator/update_contact_stage", updateContactStage],
  ["orchestrator/search_contacts", searchContacts],
  ["orchestrator/list_all_contacts", listAllContacts],
  ["orchestrator/research_contact", researchContact],
  ["orchestrator/get_communication_log", getCommunicationLog],

  // Orchestrator — Meetings
  ["orchestrator/get_meeting_history", getMeetingHistory],
  ["orchestrator/log_meeting_context", logMeetingContext],
  ["orchestrator/analyze_transcript", analyzeTranscript],

  // Orchestrator — Tasks
  ["orchestrator/get_all_tasks", getAllTasks],

  // Orchestrator — Drive
  ["orchestrator/read_google_sheet", readGoogleSheet],
  ["orchestrator/read_google_doc", readGoogleDoc],
  ["orchestrator/search_google_drive", searchGoogleDrive],

  // Orchestrator — Business
  ["orchestrator/get_business_context", getBusinessContext],
  ["orchestrator/get_daily_checkin_history", getDailyCheckinHistory],
  ["orchestrator/get_411_plan", get411Plan],
  ["orchestrator/get_team_roster", getTeamRoster],

  // Orchestrator — Goals
  ["orchestrator/update_goal_status", updateGoalStatus],

  // Orchestrator — Web (native — handler exists for completeness; runtime
  // never invokes it because is_native=1 short-circuits resolveTool)
  ["orchestrator/web_search", webSearch],
  ["orchestrator/browse_url", browseUrl],

  // Orchestrator — DB
  ["orchestrator/query_database", queryDatabase],

  // Orchestrator — Reports
  ["orchestrator/send_eod_report", sendEodReport],
]);
