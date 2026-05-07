// Shared helper used by every feedback-submitting surface (email thumbs,
// task reorder Brain Training, idea park/override/escalate). Fires a toast
// with a "Train now" action that, when clicked, stashes a hint in
// sessionStorage and dispatches a `tcc-nav` event — App.tsx listens and
// switches view to "agents". AgentsSettingsView reads the hint, opens the
// right agent tab, and pre-selects the just-submitted row.
//
// Using a custom event instead of an onSetView prop avoids drilling that
// prop through every component that captures feedback. App.tsx's listener
// is the single source of truth for nav.

import { showToast } from "@/components/tcc/Toast";

export const TCC_NAV_EVENT = "tcc-nav";

interface TrainNowToastOpts {
  /** Agent the feedback applies to — must match an entry in the Agents
   *  Training sidebar (e.g. "email", "ideas", "tasks"). */
  agent: string;
  /** agent_feedback.id when the API returned one. Preferred match key. */
  feedbackId?: string | null;
  /** Fallback: the source row id (email id, idea id, task id). Used by the
   *  consumer to find the matching row when feedbackId is missing. */
  sourceId?: string | null;
  /** Plain-language sentence shown above the action button.
   *  e.g. "Train the email agent on this thumbs-up?" */
  description: string;
  /** Title line. e.g. "Marked as important", "Idea parked". */
  title: string;
}

export function showTrainNowToast(opts: TrainNowToastOpts): void {
  const hint = {
    agent: opts.agent,
    feedbackId: opts.feedbackId ?? null,
    sourceId: opts.sourceId ?? null,
    ts: Date.now(),
  };
  showToast({
    title: opts.title,
    description: opts.description,
    action: {
      label: "Train now",
      onClick: () => {
        try { sessionStorage.setItem("tcc_pending_train", JSON.stringify(hint)); } catch { /* sessionStorage unavailable */ }
        // Must match View type in App.tsx — "agents-settings" is the actual
        // view key. "agents" silently falls through and lands somewhere else
        // (Tony saw it land on the schedule page).
        window.dispatchEvent(new CustomEvent(TCC_NAV_EVENT, { detail: { view: "agents-settings" } }));
      },
    },
  });
}
