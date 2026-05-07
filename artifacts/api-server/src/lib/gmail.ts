import { getGmail } from "./google-auth";

export async function listRecentEmails(maxResults = 10): Promise<{
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}[]> {
  try {
    const gmail = await getGmail();
    const list = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      q: "is:unread",
    });

    const messages = list.data.messages || [];
    const results = [];

    for (const msg of messages.slice(0, maxResults)) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers || [];
      const getHeader = (name: string) => headers.find(h => h.name === name)?.value || "";

      results.push({
        id: msg.id!,
        from: getHeader("From"),
        subject: getHeader("Subject"),
        snippet: detail.data.snippet || "",
        date: getHeader("Date"),
      });
    }

    return results;
  } catch (err) {
    console.warn("[Gmail] listRecentEmails failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function draftReply(params: {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
}): Promise<{ ok: boolean; draftId?: string; error?: string }> {
  try {
    const gmail = await getGmail();
    const raw = Buffer.from(
      [
        `To: ${params.to}`,
        `Subject: ${params.subject}`,
        `Content-Type: text/plain; charset=UTF-8`,
        "",
        params.body,
      ].join("\r\n")
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const draft = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          ...(params.threadId ? { threadId: params.threadId } : {}),
        },
      },
    });

    return { ok: true, draftId: draft.data.id || undefined };
  } catch (err) {
    console.warn("[Gmail] draftReply failed:", err instanceof Error ? err.message : err);
    return { ok: false, error: String(err) };
  }
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  body: string;
  /** Optional HTML body. When provided, the email is sent as
   *  multipart/alternative with both the plain `body` (fallback) and the
   *  `html` version. Plain-text-only sends keep the original Content-Type. */
  html?: string;
  threadId?: string;
  cc?: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  try {
    const gmail = await getGmail();
    let mime: string;
    if (params.html) {
      // RFC 2046 multipart/alternative — clients pick HTML when supported,
      // fall back to plain `body`. Boundary just needs to be unique within
      // this message; a timestamp + random suffix is plenty.
      const boundary = `tcc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const headers = [
        `To: ${params.to}`,
        `Subject: ${params.subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ];
      if (params.cc) headers.splice(2, 0, `Cc: ${params.cc}`);
      mime = [
        ...headers,
        "",
        `--${boundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        "",
        params.body,
        "",
        `--${boundary}`,
        `Content-Type: text/html; charset=UTF-8`,
        "",
        params.html,
        "",
        `--${boundary}--`,
      ].join("\r\n");
    } else {
      const headerLines = [
        `To: ${params.to}`,
        `Subject: ${params.subject}`,
        `Content-Type: text/plain; charset=UTF-8`,
      ];
      if (params.cc) headerLines.push(`Cc: ${params.cc}`);
      headerLines.push("", params.body);
      mime = headerLines.join("\r\n");
    }

    const raw = Buffer.from(mime)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        ...(params.threadId ? { threadId: params.threadId } : {}),
      },
    });

    return { ok: true, messageId: sent.data.id || undefined };
  } catch (err) {
    // Extract the cleanest message from Gmail's response so the FE can show
    // it directly. The Google client throws GaxiosError with .message AND a
    // nested .response.data.error structure depending on the failure type.
    const anyErr = err as { message?: string; response?: { data?: { error?: { message?: string } | string } } };
    const apiMsg = typeof anyErr?.response?.data === "object" && anyErr.response.data
      ? (typeof anyErr.response.data.error === "object" ? anyErr.response.data.error?.message : anyErr.response.data.error)
      : undefined;
    const msg = apiMsg || anyErr?.message || String(err);
    console.warn("[Gmail] sendEmail failed:", msg);
    return { ok: false, error: msg.slice(0, 300) };
  }
}

export async function searchEmails(query: string, maxResults = 20): Promise<{
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
}[]> {
  try {
    const gmail = await getGmail();
    const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
    const messages = list.data.messages || [];
    const results = [];

    for (const msg of messages.slice(0, maxResults)) {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers || [];
      const getHeader = (name: string) => headers.find(h => h.name === name)?.value || "";
      const labelIds = detail.data.labelIds || [];

      results.push({
        id: msg.id!,
        threadId: detail.data.threadId || "",
        from: getHeader("From"),
        to: getHeader("To"),
        subject: getHeader("Subject"),
        snippet: detail.data.snippet || "",
        date: getHeader("Date"),
        unread: labelIds.includes("UNREAD"),
      });
    }

    return results;
  } catch (err) {
    console.warn("[Gmail] searchEmails failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function getEmailThread(threadId: string): Promise<{
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}[]> {
  try {
    const gmail = await getGmail();
    const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const messages = thread.data.messages || [];

    return messages.map(msg => {
      const headers = msg.payload?.headers || [];
      const getHeader = (name: string) => headers.find(h => h.name === name)?.value || "";

      const findBody = (part: typeof msg.payload): string => {
        if (!part) return "";
        if (part.mimeType === "text/plain" && part.body?.data) {
          return Buffer.from(part.body.data, "base64").toString("utf-8");
        }
        if (part.parts) {
          for (const p of part.parts) {
            const text = findBody(p);
            if (text) return text;
          }
        }
        return "";
      };

      return {
        id: msg.id || "",
        from: getHeader("From"),
        to: getHeader("To"),
        subject: getHeader("Subject"),
        body: findBody(msg.payload),
        date: getHeader("Date"),
      };
    });
  } catch (err) {
    console.warn("[Gmail] getEmailThread failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
