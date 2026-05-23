import { useState, useEffect, useCallback, useRef } from "react";
import { get, post, del } from "@/lib/api";
import { FontLink } from "@/components/tcc/FontLink";
import { CheckinGate } from "@/components/tcc/CheckinGate";
import { JournalGate } from "@/components/tcc/JournalGate";
import { Header } from "@/components/tcc/Header";
import { CalendarSidebar } from "@/components/tcc/CalendarSidebar";
import { IdeasModal } from "@/components/tcc/IdeasModal";
import { AttemptModal } from "@/components/tcc/AttemptModal";
import { ClaudeModal } from "@/components/tcc/ClaudeModal";
import { EmailCompose } from "@/components/tcc/EmailCompose";
import { ConnectedCallModal } from "@/components/tcc/ConnectedCallModal";
import { EmailsView } from "@/components/tcc/EmailsView";
import { ScheduleView } from "@/components/tcc/ScheduleView";
import { SalesView } from "@/components/tcc/SalesView";
import { CommandBrainView } from "@/components/tcc/chat/CommandBrainView";
import { PrintView } from "@/components/tcc/PrintView";
import { DashboardView } from "@/components/tcc/DashboardView";
import { BusinessView } from "@/components/tcc/BusinessView";
import { AiUsageView } from "@/components/tcc/AiUsageView";
import { AgentsSettingsView } from "@/components/tcc/AgentsSettingsView";
import { ModelSettingsView } from "@/components/tcc/ModelSettingsView";
import { ReclassifyModal, type ReclassifyMode } from "@/components/tcc/ReclassifyModal";
import { ToastViewport } from "@/components/tcc/Toast";
import { C, F, FS } from "@/components/tcc/constants";
import type { CheckinState, CalItem, EmailItem, TaskItem, Contact, CallEntry, Idea, DailyBrief, SlackItem, LinearItem } from "@/components/tcc/types";

type View = "checkin" | "journal" | "dashboard" | "emails" | "schedule" | "sales" | "chat" | "business" | "ai-usage" | "agents-settings" | "model-settings";
type BusinessTab = "goals" | "team" | "tasks" | "plan" | "ideas";

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [prevView, setPrevView] = useState<View>("emails");
  const [businessTab, setBusinessTab] = useState<BusinessTab>("goals");
  const [clock, setClock] = useState(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }));
  const [loading, setLoading] = useState(true);

  // Check-in state
  const [ck, setCk] = useState<CheckinState>({ bed: "", wake: "", sleep: "", bible: false, workout: false, journal: false, nut: "Good", unplug: false, done: false });

  // Brief / schedule data
  const [brief, setBrief] = useState<DailyBrief | null>(null);

  // Emails state
  const [snoozed, setSnoozed] = useState<Record<number, string>>({});

  // Tasks state
  const [tDone, setTDone] = useState<Record<string, boolean>>({});

  // Sales state
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [calls, setCalls] = useState<CallEntry[]>([]);
  const [attempt, setAttempt] = useState<{ id: string | number; name: string; email?: string } | null>(null);
  const [calSide, setCalSide] = useState(false);

  // Ideas state
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [showIdea, setShowIdea] = useState(false);

  // Email compose state
  const [emailCompose, setEmailCompose] = useState<{
    to?: string; subject?: string; body?: string;
    contactId?: string; contactName?: string;
    replyToSnippet?: string; threadId?: string;
  } | null>(null);

  // Connected call modal state
  const [connectedCall, setConnectedCall] = useState<{
    contactId: string; contactName: string; contactEmail?: string;
  } | null>(null);

  // Chat context state (Prompt 03)
  const [chatContext, setChatContext] = useState<{
    contextType: string; contextId: string; contextLabel: string;
  } | null>(null);

  // Print mode
  const [printMode, setPrintMode] = useState(false);

  // UI state
  const [showChat, setShowChat] = useState(false);
  const [eod, setEod] = useState(false);
  const [meetingWarning, setMeetingWarning] = useState<{ title: string; time: string; location?: string; attendeeBrief?: string } | null>(null);
  const [scopeWarn, setScopeWarn] = useState<{
    message: string;
    type: "morning" | "scope";
    onOverride: () => void;
    onAccept: () => void;
  } | null>(null);

  // Custom instructions (Ctrl+hover editable tooltips)
  const [customTips, setCustomTips] = useState<Record<string, string>>({});

  const handleTipSaved = useCallback((key: string, text: string) => {
    setCustomTips(prev => ({ ...prev, [key]: text }));
  }, []);

  // ─── Section loading state ─────────────────────────────────────────────────
  // Each view-scoped section (calendar, emails, slack, linear) has its own
  // loaded flag so skeletons can hide independently as data arrives.
  const [lastRefresh, setLastRefresh] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);
  const [lastEmailAiAt, setLastEmailAiAt] = useState<Date | null>(null);
  const [sectionsLoaded, setSectionsLoaded] = useState({ calendar: false, emails: false, slack: false, linear: false });

  // ─── Per-section loaders ───────────────────────────────────────────────────
  // Each loads from cache (fast). Pass force=true to bypass cache + run live
  // fetch (calendar/linear/slack) or full AI reclassify (emails).
  type CalendarRes = { calendarData: CalItem[]; fetchedAt: string | null };
  type EmailsRes = { emailsImportant: EmailItem[]; emailsFyi: EmailItem[]; emailsPromotions: EmailItem[]; aiProcessedAt: string | null; fetchedAt: string | null };
  type SlackRes = { slackItems: SlackItem[]; fetchedAt: string | null };
  type LinearRes = { linearItems: LinearItem[]; fetchedAt: string | null };

  const loadCalendar = useCallback(async (force = false) => {
    try {
      if (force) await post<{ ok: boolean }>("/brief/calendar/refetch", {}).catch(() => {});
      const r = await get<CalendarRes>("/brief/calendar");
      setBrief(prev => ({ ...(prev ?? {} as DailyBrief), calendarData: r.calendarData }));
      setSectionsLoaded(s => ({ ...s, calendar: true }));
    } catch (err) { console.warn("[loadCalendar] failed:", err); }
  }, []);

  const loadEmails = useCallback(async (force = false) => {
    try {
      if (force) await post<{ ok: boolean }>("/brief/emails/reclassify", {}).catch(() => {});
      const r = await get<EmailsRes>("/brief/emails");
      setBrief(prev => ({
        ...(prev ?? {} as DailyBrief),
        emailsImportant: r.emailsImportant,
        emailsFyi: r.emailsFyi,
        emailsPromotions: r.emailsPromotions,
      }));
      setLastEmailAiAt(r.aiProcessedAt ? new Date(r.aiProcessedAt) : null);
      setSectionsLoaded(s => ({ ...s, emails: true }));
    } catch (err) { console.warn("[loadEmails] failed:", err); }
  }, []);

  const loadSlack = useCallback(async (force = false) => {
    try {
      if (force) await post<{ ok: boolean }>("/brief/slack/refetch", {}).catch(() => {});
      const r = await get<SlackRes>("/brief/slack");
      setBrief(prev => ({ ...(prev ?? {} as DailyBrief), slackItems: r.slackItems }));
      setSectionsLoaded(s => ({ ...s, slack: true }));
    } catch (err) { console.warn("[loadSlack] failed:", err); }
  }, []);

  // Linear engineering tasks for the Dashboard "Operations & Awareness" table.
  // Uses /linear/live (returns up to 200 issues with full cycle/team/project
  // metadata) — the /brief/linear cache only summarizes a few items, so the
  // rich live data is the source of truth for this section.
  const [liveLinear, setLiveLinear] = useState<LinearItem[]>([]);
  const loadLinear = useCallback(async (_force = false) => {
    try {
      const data = await get<LinearItem[]>("/linear/live");
      if (Array.isArray(data)) setLiveLinear(data);
      setSectionsLoaded(s => ({ ...s, linear: true }));
    } catch (err) { console.warn("[loadLinear] failed:", err); }
  }, []);

  // Backward-compat: refreshBrief(sources?) — maps sources to per-section calls.
  // Without sources: refreshes everything in parallel.
  const refreshBrief = useCallback(async (sources?: string[]) => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const which = sources?.length ? sources : ["calendar", "emails", "slack", "linear"];
      // Hamburger / global refresh: also re-pull contacts + calls so the
      // Sales Calls list reflects any status / follow-up changes made elsewhere
      // (Tony's 2026-05-16 feedback: "Refreshing in the hamburger menu did not
      // remove it from the list"). Per-section refresh paths (sources passed
      // explicitly) keep their narrower scope. Inlined here (vs reusing
      // loadContacts/loadCalls) to avoid TS hoisting issues since those are
      // declared later in the component.
      const isFullRefresh = !sources?.length;
      await Promise.all([
        ...which.map(s => {
          if (s === "calendar") return loadCalendar(true);
          if (s === "emails")   return loadEmails(true);
          if (s === "slack")    return loadSlack(true);
          if (s === "linear")   return loadLinear(true);
          return Promise.resolve();
        }),
        ...(isFullRefresh ? [
          get<{ contacts: Contact[]; total: number } | Contact[]>("/contacts?limit=50")
            .then(r => setContacts(Array.isArray(r) ? r : r.contacts))
            .catch(() => {}),
          get<CallEntry[]>("/calls")
            .then(d => setCalls(d ?? []))
            .catch(() => {}),
        ] : []),
      ]);
      setLastRefresh(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, loadCalendar, loadEmails, loadSlack, loadLinear]);

  // ─── New-email banner state ────────────────────────────────────────────────
  // 15-min poll detects new Gmail messages. If AI is stale (>6h since last
  // reclassify), reclassification fires automatically. Otherwise the banner
  // asks Tony to reclassify.
  const [newEmailCount, setNewEmailCount] = useState(0);
  const [pendingNewEmails, setPendingNewEmails] = useState<{ from: string; subject: string; snippet: string; messageId: string }[]>([]);
  const [reclassifying, setReclassifying] = useState(false);

  const reclassifyEmailsNow = useCallback(async () => {
    if (reclassifying) return;
    setReclassifying(true);
    // Clear banner state EAGERLY so the user sees immediate feedback.
    // If loadEmails fails, the next pollEmailStatus tick will repopulate.
    setNewEmailCount(0);
    setPendingNewEmails([]);
    try {
      await loadEmails(true);
    } finally {
      setReclassifying(false);
    }
  }, [reclassifying, loadEmails]);

  const dismissNewEmails = () => { setNewEmailCount(0); setPendingNewEmails([]); };

  // ─── 15-min auto-refresh interval ──────────────────────────────────────────
  // Refetches all sections raw. Emails are POLLED (not reclassified). If AI
  // is stale (>6h), reclassification kicks off automatically. Otherwise new
  // emails surface via the banner.
  //
  // Also: pollEmailStatus runs on tab focus so the banner reflects DB truth
  // shortly after the 6h server-side cron completes (Bug 6) without waiting
  // for the 15-min interval.
  const pollEmailStatus = useCallback(async () => {
    try {
      const res = await post<{ ok: boolean; newCount: number; newEmails: { from: string; subject: string; snippet: string; messageId: string }[]; aiProcessedAt: string | null; aiStale: boolean }>("/brief/emails/poll", {});
      if (res?.aiStale) {
        // AI hasn't run in >6h — reclassify automatically. This also clears
        // newEmailCount inside reclassifyEmailsNow.
        await reclassifyEmailsNow();
        return;
      }
      if (res?.newCount > 0) {
        // Append new emails to banner queue (de-dupe by messageId).
        setPendingNewEmails(prev => {
          const seen = new Set(prev.map(p => p.messageId));
          const fresh = res.newEmails.filter(n => !seen.has(n.messageId));
          const next = [...prev, ...fresh];
          // Banner count is the size of the de-duped queue, not a running
          // sum — otherwise repeated polls inflate the count past reality.
          setNewEmailCount(next.length);
          return next;
        });
      } else {
        // No new emails on the server (either nothing arrived OR the 6h cron
        // just classified them all). Drop the banner so it doesn't sit there
        // claiming "13 new" forever after auto-reclassify completes.
        setNewEmailCount(0);
        setPendingNewEmails([]);
      }
    } catch { /* silent */ }
  }, [reclassifyEmailsNow]);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      // Background refetch of calendar / linear / slack. Linear uses /linear/live
      // directly (no refetch endpoint — live fetch is fast and returns full data).
      Promise.allSettled([
        post<{ ok: boolean }>("/brief/calendar/refetch", {}).then(() => loadCalendar()),
        loadLinear(),
        post<{ ok: boolean }>("/brief/slack/refetch", {}).then(() => loadSlack()),
      ]).catch(() => {});

      if (cancelled) return;
      await pollEmailStatus();
    };

    const interval = setInterval(tick, 15 * 60 * 1000);

    // Tab focus → quick poll so the banner clears soon after cron auto-reclassify.
    const onFocus = () => { if (!cancelled) pollEmailStatus(); };
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadCalendar, loadLinear, loadSlack, pollEmailStatus]);

  const [showReclassifyModal, setShowReclassifyModal] = useState(false);
  const openReclassifyModal = () => setShowReclassifyModal(true);
  const handleReclassifySubmit = async ({ mode, sinceUnixSeconds }: { mode: ReclassifyMode; sinceUnixSeconds?: number }) => {
    setReclassifying(true);
    try {
      // Granular reclassify (modes: all / new / custom) — keep existing legacy
      // endpoint for the explicit "Reclassify All" modal flow.
      const body: { mode: ReclassifyMode; sinceUnixSeconds?: number; newEmails?: typeof pendingNewEmails } = { mode };
      if (mode === "new") body.newEmails = pendingNewEmails;
      if (mode === "custom") body.sinceUnixSeconds = sinceUnixSeconds;
      const res = await post<{ ok: boolean; emailsImportant?: any[]; emailsFyi?: any[]; emailsPromotions?: any[] }>("/emails/reclassify", body);
      if (res?.ok) {
        // Optimistically update brief state from the response so the badge
        // count + email lists re-derive immediately (Bug 7). Then reload from
        // the section cache to keep timestamps aligned.
        if (res.emailsImportant || res.emailsFyi || res.emailsPromotions) {
          setBrief(prev => ({
            ...(prev ?? {} as DailyBrief),
            emailsImportant: res.emailsImportant ?? prev?.emailsImportant ?? [],
            emailsFyi: res.emailsFyi ?? prev?.emailsFyi ?? [],
            emailsPromotions: res.emailsPromotions ?? prev?.emailsPromotions ?? [],
          }));
        }
        await loadEmails();
      }
      // Banner state cleared on every modal-submit path (Bug 6).
      setNewEmailCount(0);
      setPendingNewEmails([]);
      setShowReclassifyModal(false);
    } catch {
      await loadEmails(true);
      setNewEmailCount(0);
      setPendingNewEmails([]);
      setShowReclassifyModal(false);
    }
    setReclassifying(false);
  };

  // Auto-EOD at 4:30 PM Pacific — polls every minute, handles retroactive send
  useEffect(() => {
    let eodSentToday = false;

    const checkAutoEod = async () => {
      if (eodSentToday) return;
      const now = new Date();
      const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
      const hour = pacific.getHours();
      const minute = pacific.getMinutes();

      if ((hour === 16 && minute >= 30) || hour >= 17) {
        try {
          await post<{ ok: boolean; alreadySent: boolean }>("/eod-report/auto", {});
          eodSentToday = true;
          setEod(true);
        } catch {
          /* silent — Tony can say "send EOD" in Claude Chat */
        }
      }
    };

    checkAutoEod();
    const interval = setInterval(checkAutoEod, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Persist active view so Tony resumes exactly where he left off on reload
  const persistView = useCallback((v: View) => {
    if (view !== "chat") setPrevView(view);
    setView(v);
    if (v !== "checkin" && v !== "journal" && v !== "chat") {
      post("/system-instructions", { key: "active_view", text: v }).catch(() => {});
    }
  }, [view]);

  // Listen for nav-from-toast events so any deeply-nested component can
  // request a view switch without prop-drilling onSetView. Used by the
  // shared "Train now" toast helper after feedback is submitted.
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ view?: string }>).detail;
      if (detail?.view) persistView(detail.view as View);
    };
    window.addEventListener("tcc-nav", onNav);
    return () => window.removeEventListener("tcc-nav", onNav);
  }, [persistView]);

  useEffect(() => {
    const i = setInterval(() => setClock(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })), 30000);
    return () => clearInterval(i);
  }, []);

  // 5-min meeting warnings (Pacific-timezone aware — times from API are Pacific)
  useEffect(() => {
    if (!brief?.calendarData) return;
    const nowParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const nowH = parseInt(nowParts.find(p => p.type === "hour")?.value || "0");
    const nowM = parseInt(nowParts.find(p => p.type === "minute")?.value || "0");
    const nowS = parseInt(nowParts.find(p => p.type === "second")?.value || "0");
    const nowPacificMin = (nowH === 24 ? 0 : nowH) * 60 + nowM + nowS / 60;
    const parseTimeToMin = (t: string): number | null => {
      const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!m) return null;
      let h = parseInt(m[1]); const min = parseInt(m[2]); const ampm = m[3].toUpperCase();
      if (ampm === "PM" && h < 12) h += 12;
      if (ampm === "AM" && h === 12) h = 0;
      return h * 60 + min;
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const item of brief.calendarData) {
      if (!item.real) continue;
      const startMin = parseTimeToMin(item.t);
      if (startMin === null) continue;
      const msUntilWarning = (startMin - nowPacificMin - 5) * 60 * 1000;
      if (msUntilWarning > 0 && msUntilWarning < 8 * 60 * 60 * 1000) {
        timers.push(setTimeout(() => setMeetingWarning({ title: item.n, time: item.t, location: item.loc, attendeeBrief: (item as any).attendeeBrief || item.note || undefined }), msUntilWarning));
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [brief?.calendarData]);

  // Auto-dismiss meeting warning after 15 seconds
  useEffect(() => {
    if (!meetingWarning) return;
    const t = setTimeout(() => setMeetingWarning(null), 15_000);
    return () => clearTimeout(t);
  }, [meetingWarning]);

  // Load state in two phases:
  //   Phase 1 (blocking) — checkin + journal + instructions decide which view to show.
  //   Phase 2 (background) — brief, calls, ideas, snoozed, tasks populate the dashboard
  //     while the shell + skeletons are already on screen.
  useEffect(() => {
    (async () => {
      try {
        const [checkin, journal, instructionsData] = await Promise.all([
          get<{ id?: string; done?: boolean; bedtime?: string; waketime?: string; sleepHours?: string; bible?: boolean; workout?: boolean; journal?: boolean; nutrition?: string; unplug?: boolean }>("/checkin/today").catch(() => null),
          get<{ formattedText?: string; rawText?: string }>("/journal/today").catch(() => null),
          get<Record<string, string>>("/system-instructions").catch(() => ({})),
        ]);

        if (checkin?.id) {
          const loaded: CheckinState = {
            bed: checkin.bedtime || "",
            wake: checkin.waketime || "",
            sleep: checkin.sleepHours || "",
            bible: checkin.bible || false,
            workout: checkin.workout || false,
            journal: checkin.journal || false,
            nut: checkin.nutrition || "Good",
            unplug: checkin.unplug || false,
            done: true,
          };
          setCk(loaded);

          if (journal?.formattedText || journal?.rawText) {
            const VALID_VIEWS: View[] = ["dashboard", "emails", "schedule", "sales", "business", "ai-usage", "agents-settings", "model-settings"];
            const savedView = (instructionsData as Record<string, string>)?.["active_view"] as View | undefined;
            const restoredView = savedView && VALID_VIEWS.includes(savedView) ? savedView : "dashboard";
            setView(restoredView);
          } else {
            setView("journal");
          }
        }

        if (instructionsData && Object.keys(instructionsData).length > 0) {
          const tipKeys = Object.fromEntries(
            Object.entries(instructionsData).filter(([k]) => k !== "active_view" && k !== "email_brain")
          );
          setCustomTips(tipKeys);
        }
      } catch {
        /* start fresh */
      }

      // Render the shell — view-scoped loaders fire below.
      setLoading(false);

      // Slack always loads (header bell visible on every view).
      loadSlack();

      // Note: per-section data + cross-view (calls/ideas/snoozed/completed)
      // are loaded by the view-change effect below based on which view is
      // active. This keeps initial load lean.

      setLastRefresh(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }));
    })();
  }, []);

  // ─── View-scoped section loading ───────────────────────────────────────────
  // Each view triggers loads only for the data it actually displays. Already-
  // loaded sections stay cached in state — no refetch on revisit.
  const [callsLoaded, setCallsLoaded] = useState(false);
  const [ideasLoaded, setIdeasLoaded] = useState(false);
  const [snoozedLoaded, setSnoozedLoaded] = useState(false);
  const [tasksCompletedLoaded, setTasksCompletedLoaded] = useState(false);

  const loadCalls = useCallback((force = false) => {
    if (callsLoaded && !force) return;
    get<CallEntry[]>("/calls").then(d => { setCalls(d ?? []); }).catch(() => {});
    setCallsLoaded(true);
  }, [callsLoaded]);

  const loadIdeas = useCallback(() => {
    if (ideasLoaded) return;
    get<Idea[]>("/ideas").then(d => { if (d?.length) setIdeas(d); }).catch(() => {});
    setIdeasLoaded(true);
  }, [ideasLoaded]);

  const loadSnoozed = useCallback(() => {
    if (snoozedLoaded) return;
    get<Record<number, string>>("/emails/snoozed").then(d => { if (d) setSnoozed(d); }).catch(() => {});
    setSnoozedLoaded(true);
  }, [snoozedLoaded]);

  const loadTasksCompleted = useCallback(() => {
    if (tasksCompletedLoaded) return;
    get<{ taskId: string }[]>("/tasks/completed").then(d => {
      if (d?.length) {
        const done: Record<string, boolean> = {};
        for (const t of d) done[t.taskId] = true;
        setTDone(done);
      }
    }).catch(() => {});
    setTasksCompletedLoaded(true);
  }, [tasksCompletedLoaded]);

  const loadContacts = useCallback((force = false) => {
    if (contactsLoaded && !force) return;
    get<{ contacts: Contact[]; total: number } | Contact[]>("/contacts?limit=50").then(r => {
      const list = Array.isArray(r) ? r : r.contacts;
      setContacts(list);
      setContactsLoaded(true);
    }).catch(() => {
      setContactsLoaded(true);
    });
  }, [contactsLoaded]);

  // Per-view section requirements. Only fires loaders for sections this view
  // displays. Already-loaded sections short-circuit (no-op).
  //
  // Calendar gets a one-time forced refresh per session on the first dashboard
  // open (Tony's 2026-05-16 feedback: "At entry I needed it to refresh it in
  // order for it to match"). The sessionStorage flag persists across re-mounts
  // within the same tab but resets when the tab is closed, so the next session
  // re-fetches live GCal once.
  useEffect(() => {
    if (loading) return;
    const calendarFirstRefreshDone = sessionStorage.getItem("tcc.calendar.firstRefreshDone") === "1";
    const forceCalendarOnce = !calendarFirstRefreshDone;
    const markCalendarRefreshed = () => sessionStorage.setItem("tcc.calendar.firstRefreshDone", "1");

    switch (view) {
      case "dashboard":
        loadCalendar(forceCalendarOnce).then(() => { if (forceCalendarOnce) markCalendarRefreshed(); });
        loadEmails(); loadLinear();
        loadCalls(); loadContacts(); loadSnoozed(); loadTasksCompleted();
        break;
      case "emails":
        loadEmails(); loadSnoozed();
        break;
      case "schedule":
        loadCalendar(forceCalendarOnce).then(() => { if (forceCalendarOnce) markCalendarRefreshed(); });
        break;
      case "sales":
        loadContacts(); loadCalls();
        loadCalendar(forceCalendarOnce).then(() => { if (forceCalendarOnce) markCalendarRefreshed(); });
        break;
      case "business":
        loadLinear(); loadIdeas();
        break;
      // checkin / journal / chat / ai-usage / agents-settings — no section data needed
    }
  }, [view, loading, loadCalendar, loadEmails, loadLinear, loadCalls, loadContacts, loadSnoozed, loadTasksCompleted, loadIdeas]);

  const handleSnooze = useCallback((emailId: number, until: string) => {
    setSnoozed(prev => ({ ...prev, [emailId]: until }));
  }, []);

  const handleTaskComplete = useCallback(async (task: TaskItem) => {
    if (task.sales) { persistView("sales"); return; }
    const newVal = !tDone[task.id];
    setTDone(prev => ({ ...prev, [task.id]: newVal }));
    if (newVal) {
      post("/tasks/completed", { taskId: task.id, taskText: task.text }).catch(err => console.error("[TCC] Task complete failed:", err));
    } else {
      del(`/tasks/completed/${encodeURIComponent(task.id)}`).catch(err => console.error("[TCC] Task uncomplete failed:", err));
    }
  }, [tDone]);

  const handleLogCall = useCallback(async (contactName: string, type: string, contactId?: string) => {
    try {
      const call = await post<CallEntry>("/calls", { contactId, contactName, type });
      setCalls(prev => [...prev, call]);
    } catch {
      setCalls(prev => [...prev, { contactId, contactName, type, createdAt: new Date().toISOString() }]);
    }
  }, []);

  const handleEod = useCallback(async () => {
    setEod(true);
    post("/eod-report", {}).catch(() => {});
  }, []);

  // Morning protection: block non-sales scheduling before noon Pacific
  const checkMorningProtection = useCallback((onAccept: () => void, onOverride: () => void) => {
    try {
      const now = new Date();
      const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
      const h = pacific.getHours();
      const isBeforeNoon = h < 12;
      if (isBeforeNoon) {
        setScopeWarn({
          message: "Mornings are protected for sales calls (before noon Pacific). Move this to afternoon?",
          type: "morning",
          onAccept,
          onOverride,
        });
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }, []);

  // Scope gatekeeper: Sales > Ramy support > everything else
  const checkScopeGuard = useCallback((taskDescription: string, onAccept: () => void, onOverride: () => void) => {
    const lower = taskDescription.toLowerCase();
    const isSales = lower.includes("sales") || lower.includes("call") || lower.includes("demo") || lower.includes("prospect") || lower.includes("pipeline");
    const isRamy = lower.includes("ramy") || lower.includes("support");
    if (!isSales && !isRamy) {
      setScopeWarn({
        message: `"${taskDescription.substring(0, 60)}" isn't in your scope (Sales or Ramy support). Delegate to Ethan or park it?`,
        type: "scope",
        onAccept,
        onOverride,
      });
      return true;
    }
    return false;
  }, []);

  // Prompt 03: open chat with context from another view
  const openChatWithContext = useCallback((contextType: string, contextId: string, contextLabel: string) => {
    setChatContext({ contextType, contextId, contextLabel });
    persistView("chat");
  }, [persistView]);

  const unresolved = (brief?.emailsImportant || []).filter(e => !snoozed[e.id]).length;

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F }}>
        <FontLink />
        {/* Header skeleton */}
        <div style={{ background: "#fff", borderBottom: `1px solid ${C.brd}`, padding: "12px 20px", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "#EEE" }} />
          <div style={{ flex: 1 }}>
            <div style={{ width: 200, height: 14, background: "#EEE", borderRadius: 4, marginBottom: 4 }} />
            <div style={{ width: 140, height: 10, background: "#F2F2F2", borderRadius: 4 }} />
          </div>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "#F2F2F2" }} />
        </div>
        {/* Skeleton cards */}
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ background: "#fff", border: `1px solid ${C.brd}`, borderRadius: 10, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ width: 160, height: 14, background: "#EEE", borderRadius: 4 }} />
                <div style={{ width: 80, height: 10, background: "#F2F2F2", borderRadius: 4 }} />
              </div>
              {[0, 1, 2].map(j => (
                <div key={j} style={{ display: "flex", gap: 10, padding: "8px 0", borderTop: j === 0 ? "none" : `1px solid #F5F5F5` }}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: "#EEE" }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ width: "35%", height: 10, background: "#EEE", borderRadius: 3, marginBottom: 5 }} />
                    <div style={{ width: "70%", height: 10, background: "#F2F2F2", borderRadius: 3 }} />
                  </div>
                </div>
              ))}
            </div>
          ))}
          <div style={{ textAlign: "center", color: C.mut, fontSize: 12, fontStyle: "italic", padding: "8px 0" }}>
            Loading your day…
          </div>
        </div>
      </div>
    );
  }

  // ═══ CHAT VIEW (full screen) ═══
  if (view === "chat") {
    return (
      <>
        <FontLink />
        <CommandBrainView
          onBack={() => { setChatContext(null); setView(prevView || "emails"); }}
          initialContextType={chatContext?.contextType}
          initialContextId={chatContext?.contextId}
          initialContextLabel={chatContext?.contextLabel}
        />
      </>
    );
  }

  // Real calendar items only (matches what DashboardView shows)
  const realCalItems = (brief?.calendarData || []).filter(c => c.real);

  // Live Linear data takes precedence over cached brief data
  const activeLinearItems: LinearItem[] = liveLinear.length ? liveLinear : (brief?.linearItems || []);

  // ═══ SHARED UI ELEMENTS ═══
  const sharedHeader = (
    <Header
      clock={clock}
      ideas={ideas}
      unresolved={unresolved}
      snoozedCount={Object.keys(snoozed).length}
      calSide={calSide}
      eod={eod}
      customTips={customTips}
      lastRefresh={lastRefresh}
      refreshing={refreshing}
      slackItems={(brief?.slackItems || []) as SlackItem[]}
      linearItems={activeLinearItems}
      meetingWarning={meetingWarning}
      onSetView={v => {
        if (v.startsWith("business:")) {
          const tab = v.split(":")[1] as BusinessTab;
          setBusinessTab(tab);
          persistView("business");
        } else {
          persistView(v as View);
        }
      }}
      onToggleCal={() => setCalSide(s => !s)}
      onShowIdea={() => setShowIdea(true)}
      onShowChat={() => { setChatContext(null); persistView("chat"); }}
      onShowCheckin={() => persistView("checkin")}
      onEod={handleEod}
      onTipSaved={handleTipSaved}
      onRefresh={refreshBrief}
      onDismissWarning={() => setMeetingWarning(null)}
      onPrint={() => {
        // Print sheet needs data from EVERY section (calendar / emails /
        // linear / contacts / calls). Per-view loaders only fire what the
        // current view displays, so opening Print from e.g. Sales or
        // Business shows empty cells. Kick off all loaders before flipping
        // into print mode. Each loader short-circuits if already loaded.
        loadCalendar();
        loadEmails();
        loadLinear();
        loadContacts();
        loadCalls();
        setPrintMode(true);
      }}
      // D2 (Tony's 2026-05-16): ack a Slack mention. Optimistic: pull it
      // from local state immediately so the dropdown updates without a
      // round-trip; revert if the BE call fails.
      onSlackAck={async (item) => {
        if (!item.ts || !item.channelId) return;
        const prevItems = brief?.slackItems ?? [];
        setBrief(prev => ({
          ...(prev ?? {} as DailyBrief),
          slackItems: prevItems.filter(s => s.ts !== item.ts),
        }));
        try {
          await post(`/brief/slack/mentions/${encodeURIComponent(item.ts)}/ack`, {
            channelId: item.channelId,
          });
        } catch {
          // Restore on failure
          setBrief(prev => ({ ...(prev ?? {} as DailyBrief), slackItems: prevItems }));
        }
      }}
    />
  );

  const newEmailBanner = newEmailCount > 0 ? (
    <div style={{
      background: "#EBF5FF", borderBottom: "2px solid #2563EB", padding: "10px 20px",
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
    }}>
      <span style={{ fontSize: 14, color: "#1E40AF", fontWeight: 600 }}>
        📬 {newEmailCount} new email{newEmailCount > 1 ? "s" : ""} — Reclassify?
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={reclassifyEmailsNow} disabled={reclassifying} style={{
          background: "#2563EB", color: "#fff", border: "none", borderRadius: 6,
          padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: reclassifying ? 0.6 : 1,
        }}>{reclassifying ? "Classifying…" : "Reclassify Now"}</button>
        <button onClick={dismissNewEmails} disabled={reclassifying} style={{
          background: "transparent", color: "#6B7280", border: "1px solid #D1D5DB",
          borderRadius: 6, padding: "6px 10px", fontSize: 13, cursor: "pointer",
        }}>Later</button>
      </div>
    </div>
  ) : null;

  const sharedModals = (
    <>
      <ToastViewport />
      <ReclassifyModal
        open={showReclassifyModal}
        newEmailCount={newEmailCount}
        onClose={() => { if (!reclassifying) setShowReclassifyModal(false); }}
        onSubmit={handleReclassifySubmit}
        busy={reclassifying}
      />
      {/* Scope / Morning Protection Banner */}
      {scopeWarn && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 10001,
          background: scopeWarn.type === "morning" ? C.ambBg : C.redBg,
          borderBottom: `2px solid ${scopeWarn.type === "morning" ? C.amb : C.red}`,
          padding: "14px 20px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          animation: "slideDown 0.3s ease-out",
        }}>
          <div style={{ fontSize: 14, color: C.tx, flex: 1 }}>
            {scopeWarn.type === "morning" ? "🌅 " : "🚦 "}{scopeWarn.message}
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0, marginLeft: 12 }}>
            <button
              onClick={() => { scopeWarn.onAccept(); setScopeWarn(null); }}
              style={{ padding: "6px 14px", fontSize: 12, borderRadius: 8, border: "none", cursor: "pointer",
                background: scopeWarn.type === "morning" ? C.amb : C.red, color: "#fff", fontWeight: 700 }}>
              {scopeWarn.type === "morning" ? "Move to Afternoon" : "Delegate / Park"}
            </button>
            <button
              onClick={() => {
                scopeWarn.onOverride();
                post("/ideas/notify-override", {
                  text: scopeWarn.message,
                  justification: scopeWarn.type === "morning" ? "Tony chose to schedule in morning anyway" : "Tony overrode scope check",
                }).catch(() => {});
                setScopeWarn(null);
              }}
              style={{ padding: "6px 14px", fontSize: 12, borderRadius: 8, border: `1px solid ${C.brd}`, cursor: "pointer",
                background: C.card, color: C.tx }}>
              Override
            </button>
          </div>
        </div>
      )}
      {printMode && (
        <PrintView
          tasks={brief?.tasks || []}
          tDone={tDone}
          calendarData={brief?.calendarData || []}
          emailsImportant={brief?.emailsImportant || []}
          slackItems={brief?.slackItems || []}
          linearItems={activeLinearItems}
          topCallContacts={contacts.map(c => ({ name: c.name, phone: c.phone, company: c.company, nextStep: c.nextStep }))}
          // Show "Preparing…" overlay until every section the print sheet
          // depends on has finished its initial load. Avoids flashing empty
          // rows when Print is clicked from a non-dashboard view.
          loading={!sectionsLoaded.calendar || !sectionsLoaded.emails || !sectionsLoaded.linear || !contactsLoaded || !callsLoaded}
          onClose={() => setPrintMode(false)}
          onRefresh={() => refreshBrief(["calendar", "emails"])}
        />
      )}
      <IdeasModal open={showIdea} onClose={() => setShowIdea(false)} onSave={async (idea) => {
        setIdeas(prev => [...prev, idea]);
        // Task creation is triggered explicitly inside IdeasModal via onCreateTask
      }} onCreateTask={async (ideaText, category, urgency, techType) => {
        let taskFields: any = null;
        try {
          const res = await post<{ ok: boolean; taskFields?: any }>("/ideas/generate-task", {
            ideaText, category, urgency, techType,
          });
          if (res?.ok && res.taskFields) taskFields = res.taskFields;
        } catch { /* AI task gen failed — will use fallback below */ }
        // Fallback: if AI didn't produce fields, use basic idea info
        if (!taskFields) {
          taskFields = {
            title: ideaText.slice(0, 120),
            category: category?.toLowerCase() || "tech",
            owner: "Tony",
            priority: urgency === "Now" ? "P0" : urgency === "This Week" ? "P1" : "P2",
            source: "TCC",
            workNotes: ideaText,
          };
        }
        // Always navigate to tasks tab and open the modal
        setBusinessTab("tasks");
        persistView("business");
        setTimeout(() => window.dispatchEvent(new CustomEvent("tcc:prefill-task", { detail: taskFields })), 500);
      }} count={ideas.length} />
      <ClaudeModal open={showChat} onClose={() => setShowChat(false)} />

      {/* ═══ GATE OVERLAY: Check-in ═══ */}
      {(!ck.done || view === "checkin") && (
        <div style={{ position: "fixed", inset: 0, zIndex: 2000, overflowY: "auto", background: "rgba(0,0,0,0.45)", backdropFilter: "blur(3px)" }}>
          <CheckinGate
            initial={ck}
            onComplete={async (completed) => {
              setCk(completed);
              if (ck.done) {
                setView(prevView || "dashboard");
              } else {
                // Check if journal already exists for today before showing journal gate
                try {
                  const j = await get<{ formattedText?: string; rawText?: string }>("/journal/today");
                  if (j?.formattedText || j?.rawText) {
                    setView("dashboard");
                  } else {
                    setView("journal");
                  }
                } catch {
                  setView("journal");
                }
              }
            }}
          />
        </div>
      )}

      {/* ═══ GATE OVERLAY: Journal ═══ */}
      {view === "journal" && ck.done && (
        <div style={{ position: "fixed", inset: 0, zIndex: 2000, overflowY: "auto", background: "rgba(0,0,0,0.45)", backdropFilter: "blur(3px)" }}>
          <JournalGate onComplete={() => setView("dashboard")} />
        </div>
      )}
      <EmailCompose
        open={!!emailCompose}
        onClose={() => setEmailCompose(null)}
        prefillTo={emailCompose?.to}
        prefillSubject={emailCompose?.subject}
        prefillBody={emailCompose?.body}
        prefillContactId={emailCompose?.contactId}
        prefillContactName={emailCompose?.contactName}
        replyToSnippet={emailCompose?.replyToSnippet}
        threadId={emailCompose?.threadId}
      />
      <ConnectedCallModal
        open={!!connectedCall}
        onClose={() => setConnectedCall(null)}
        contactId={connectedCall?.contactId || ""}
        contactName={connectedCall?.contactName || ""}
        contactEmail={connectedCall?.contactEmail}
        onFollowUpEmail={prefill => setEmailCompose(prefill)}
      />
    </>
  );

  // ═══ DASHBOARD VIEW (also serves as background for gate overlays) ═══
  if (view === "dashboard" || view === "checkin" || view === "journal") return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fff", fontFamily: F }}>
      {sharedHeader}
      {newEmailBanner}
      {sharedModals}
      <AttemptModal contact={attempt} onClose={() => setAttempt(null)} onLog={call => setCalls(prev => [...prev, call])} onCompose={opts => setEmailCompose({ to: opts.to, contactId: opts.contactId, contactName: opts.contactName, body: opts.body, subject: opts.subject })} />
      <DashboardView
        tasks={brief?.tasks || []}
        tDone={tDone}
        calendarData={brief?.calendarData || []}
        emailsImportant={brief?.emailsImportant || []}
        linearItems={activeLinearItems}
        contacts={contacts}
        calls={calls}
        emailsLoaded={sectionsLoaded.emails}
        briefLoaded={sectionsLoaded.calendar}
        lastEmailAiAt={lastEmailAiAt}
        onComplete={handleTaskComplete}
        onNavigate={v => {
          // Dashboard emits NavView ("tasks" | "emails" | "schedule" | "sales").
          // The parent's View enum doesn't have a top-level "tasks" — the master
          // task list lives inside BusinessView, sub-tab "tasks". Tony's
          // 2026-05-16 feedback: "Links is sending me to calendar not tasks list".
          if (v === "tasks") {
            setBusinessTab("tasks");
            persistView("business");
            return;
          }
          persistView(v as View);
        }}
        onOpenEmail={em => setEmailCompose({ threadId: em.gmailMessageId, subject: `Re: ${em.subj}` })}
        onAttempt={c => setAttempt(c)}
        onCompose={c => setEmailCompose({ to: c.email || "", contactId: String(c.id), contactName: c.name })}
        onContactUpdated={c => setContacts(prev => prev.map(x => String(x.id) === String(c.id) ? c : x))}
      />
    </div>
  );

  // ═══ EMAILS VIEW ═══
  if (view === "emails") return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F }}>
      {sharedHeader}
      {newEmailBanner}
      {sharedModals}
      <EmailsView
        emailsImportant={brief?.emailsImportant || []}
        emailsFyi={brief?.emailsFyi || []}
        emailsPromotions={brief?.emailsPromotions || []}
        snoozed={snoozed}
        customTips={customTips}
        onSnooze={handleSnooze}
        onDone={() => persistView("schedule")}
        onTipSaved={handleTipSaved}
        onRefresh={async () => { await loadEmails(true); }}
        unclassifiedEmails={pendingNewEmails}
        onReclassify={async () => {
          // Clear banner immediately on click so Tony sees feedback. If he
          // cancels the modal, polling will repopulate. If he submits,
          // handleReclassifySubmit re-confirms the cleared state.
          setNewEmailCount(0);
          setPendingNewEmails([]);
          openReclassifyModal();
        }}
        reclassifying={reclassifying}
        loaded={sectionsLoaded.emails}
        lastEmailAiAt={lastEmailAiAt}
      />
    </div>
  );

  // ═══ SALES VIEW ═══
  if (view === "sales") return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F }}>
      {sharedHeader}
      {calSide && <CalendarSidebar items={realCalItems} onClose={() => setCalSide(false)} onSchedule={() => { persistView("schedule"); setCalSide(false); }} />}
      {sharedModals}
      <AttemptModal contact={attempt} onClose={() => setAttempt(null)} onLog={call => setCalls(prev => [...prev, call])} onCompose={opts => setEmailCompose({ to: opts.to, contactId: opts.contactId, contactName: opts.contactName, body: opts.body, subject: opts.subject })} />
      <SalesView
        contacts={contacts}
        calls={calls}
        calSide={calSide}
        onAttempt={c => setAttempt(c)}
        onConnected={name => handleLogCall(name, "connected")}
        onSwitchToTasks={() => { setBusinessTab("tasks"); persistView("business"); }}
        onBackToSchedule={() => persistView("schedule")}
        onCompose={c => setEmailCompose({ to: c.email || "", contactId: String(c.id), contactName: c.name })}
        onConnectedCall={c => setConnectedCall(c)}
      />
    </div>
  );

  // ═══ BUSINESS VIEW ═══
  if (view === "business") return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F }}>
      {sharedHeader}
      {sharedModals}
      <BusinessView
        defaultTab={businessTab}
        onTabChange={setBusinessTab}
        onBack={() => persistView("dashboard")}
      />
    </div>
  );

  // ═══ AI USAGE VIEW ═══
  if (view === "ai-usage") return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F }}>
      {sharedHeader}
      {sharedModals}
      <AiUsageView onBack={() => persistView("dashboard")} />
    </div>
  );

  // ═══ AGENTS SETTINGS VIEW ═══
  if (view === "agents-settings") return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F }}>
      {sharedHeader}
      {sharedModals}
      <AgentsSettingsView onBack={() => persistView("dashboard")} />
    </div>
  );

  // ═══ MODEL SETTINGS VIEW ═══
  if (view === "model-settings") return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F }}>
      {sharedHeader}
      {sharedModals}
      <ModelSettingsView onBack={() => persistView("dashboard")} />
    </div>
  );

  // ═══ SCHEDULE VIEW (default) ═══
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F }}>
      {sharedHeader}
      {calSide && <CalendarSidebar items={realCalItems} onClose={() => setCalSide(false)} onSchedule={() => { persistView("schedule"); setCalSide(false); }} />}
      {sharedModals}
      <ScheduleView
        items={brief?.calendarData || []}
        loaded={sectionsLoaded.calendar}
        onEnterSales={() => { persistView("sales"); setCalSide(true); }}
        onEnterTasks={() => { setBusinessTab("tasks"); persistView("business"); setCalSide(true); }}
        onRefresh={async () => { await loadCalendar(true); }}
      />
    </div>
  );
}
