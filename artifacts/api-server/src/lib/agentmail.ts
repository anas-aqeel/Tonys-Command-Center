// System email sender. Now delegates to Gmail (sendEmail in lib/gmail.ts)
// using the OAuth credentials already configured for inbox polling — Tony
// owns flipiq.com via that Google account, so emails go out from the real
// flipiq.com sender with no domain-verification step required.
//
// Resend was the previous implementation but its free tier blocks sending to
// anyone except the account owner unless the sender domain is verified — a
// dead-end for system emails to assignees/partners. Gmail bypasses that.

import { sendEmail as sendGmail } from "./gmail.js";

export async function sendSystemEmail(params: {
  to: string;
  subject: string;
  body: string;
  /** Optional HTML body. If provided the email is sent as
   *  multipart/alternative; otherwise the plain `body` is sent as text. */
  html?: string;
  from?: string; // ignored — Gmail sends as the authenticated user
}): Promise<{ ok: boolean; messageId?: string; error?: string; status?: number }> {
  const r = await sendGmail({
    to: params.to,
    subject: params.subject,
    // Gmail's `body` is the plain-text part; pass html through separately.
    body: params.body,
    html: params.html,
  });
  return r;
}

// Legacy exports — agentMailRequest is no longer functional since Replit connectors
// were removed. Callers that used it for inbox polling (sheet-scan) should be updated.
export async function agentMailRequest<T = unknown>(
  _path: string,
  _options: { method?: string; body?: unknown } = {}
): Promise<T> {
  throw new Error("AgentMail is no longer available. Replit connectors have been removed.");
}

export async function sendViaAgentMail(params: {
  to: string;
  subject: string;
  body: string;
  inboxId?: string;
}): Promise<{ messageId?: string; ok: boolean }> {
  const r = await sendSystemEmail(params);
  return { ok: r.ok, messageId: r.messageId };
}
