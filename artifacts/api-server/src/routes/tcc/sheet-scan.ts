import { Router } from "express";
import { agentMailRequest } from "../../lib/agentmail";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { sharedDb, personalDb, callLogTable, taskCompletionsTable } from "@workspace/db";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";
import { sql } from "drizzle-orm";

const router = Router();

// ─── GET /sheet-scan/inbox ─────────────────────────────────────
// Returns the AgentMail inbox email address Tony should send photos to
router.get("/sheet-scan/inbox", async (_req, res) => {
  try {
    const data = await agentMailRequest<{ inboxes?: { id: string; email: string; name?: string }[] }>("/v1/inboxes");
    const inboxes = data.inboxes ?? [];
    if (inboxes.length === 0) {
      return res.status(404).json({ ok: false, error: "No AgentMail inbox found" });
    }
    const inbox = inboxes[0];
    return res.json({ ok: true, inboxId: inbox.id, email: inbox.email, name: inbox.name });
  } catch (err: unknown) {
    console.error("[sheet-scan/inbox]", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── POST /sheet-scan/process ─────────────────────────────────
// Polls AgentMail for latest email with a photo attachment,
// uses Claude Vision to parse checked boxes + notes, then updates the DB.
router.post("/sheet-scan/process", async (_req, res) => {
  try {
    // 1. Get inbox
    const inboxData = await agentMailRequest<{ inboxes?: { id: string; email: string }[] }>("/v1/inboxes");
    const inbox = inboxData.inboxes?.[0];
    if (!inbox) return res.status(404).json({ ok: false, error: "No inbox found" });

    // 2. List recent messages (newest first)
    const msgData = await agentMailRequest<{
      messages?: {
        id: string;
        subject?: string;
        from?: { email?: string };
        created_at?: string;
        attachments?: { id: string; filename?: string; content_type?: string; size?: number }[];
      }[]
    }>(`/v1/inboxes/${inbox.id}/messages?limit=10&sort=desc`);

    const messages = msgData.messages ?? [];

    // 3. Find first message with an image attachment
    let targetMsg: typeof messages[0] | null = null;
    let targetAttachment: { id: string; filename?: string; content_type?: string } | null = null;

    for (const msg of messages) {
      const imgAttachment = (msg.attachments ?? []).find(
        a => a.content_type?.startsWith("image/") || /\.(jpg|jpeg|png|heic|webp)$/i.test(a.filename ?? "")
      );
      if (imgAttachment) {
        targetMsg = msg;
        targetAttachment = imgAttachment;
        break;
      }
    }

    if (!targetMsg || !targetAttachment) {
      return res.status(404).json({
        ok: false,
        error: "No email with photo attachment found. Please email the filled sheet to the TCC inbox.",
      });
    }

    // 4. Fetch attachment as base64
    const attData = await agentMailRequest<{ content?: string; content_type?: string }>(
      `/v1/inboxes/${inbox.id}/messages/${targetMsg.id}/attachments/${targetAttachment.id}`
    );

    if (!attData.content) {
      return res.status(422).json({ ok: false, error: "Attachment has no content" });
    }

    const mediaType = (attData.content_type ?? targetAttachment.content_type ?? "image/jpeg") as
      "image/jpeg" | "image/png" | "image/gif" | "image/webp";

    // 5. Send to Claude Vision for parsing
    const today = new Date().toISOString().split("T")[0];
    const visionPrompt = `You are reading a scanned daily action sheet for Tony Diaz. 
Analyze the image carefully and extract ONLY what you can read with confidence.

Return a JSON object with this exact shape:
{
  "calls": [
    {
      "row": 1,
      "checked": true,
      "name": "person name if readable, else null",
      "outcome": "any handwritten notes in the OUTCOME/NOTES column, else null"
    }
  ],
  "top3": [
    { "row": 1, "checked": false, "note": "any handwritten note beside it, else null" },
    { "row": 2, "checked": false, "note": null },
    { "row": 3, "checked": false, "note": null }
  ],
  "appointments": [
    { "row": 1, "checked": false }
  ],
  "scratch_notes": "any text written in the scratch notes section, else null",
  "wins": ["win 1 if written, else null", "win 2 if written, else null", "win 3 if written, else null"],
  "confidence": "high"
}

Include all 10 call rows; mark checked=false if checkbox is blank/unchecked.
For confidence: high = can clearly read text, medium = partially legible, low = very hard to read.`;

    const visionContent = [
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: mediaType, data: attData.content },
      },
      { type: "text" as const, text: visionPrompt },
    ];

    let raw = "";

    // Flag-gated: AGENT_RUNTIME_INGEST=true routes through runtime.
    if (isAgentRuntimeEnabled("ingest")) {
      const result = await runAgent("ingest", "scan-paper-planner", {
        userMessage: visionContent as any,
        caller: "direct",
        meta: { mediaType },
      });
      raw = result.text;
    } else {
      const visionResponse = await createTrackedMessage("sheet_scan", {
        model: "claude-opus-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: visionContent }],
      });
      raw = visionResponse.content[0]?.type === "text" ? visionResponse.content[0].text : "";
    }
    let parsed: {
      calls?: { row: number; checked: boolean; name?: string | null; outcome?: string | null }[];
      top3?: { row: number; checked: boolean; note?: string | null }[];
      appointments?: { row: number; checked: boolean }[];
      scratch_notes?: string | null;
      wins?: (string | null)[];
      confidence?: string;
    } = {};

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      console.warn("[sheet-scan] Could not parse Claude JSON:", raw);
    }

    // 6. Update DB — log completed calls
    const callResults: string[] = [];
    for (const call of parsed.calls ?? []) {
      if (call.checked && call.name) {
        try {
          await sharedDb.insert(callLogTable).values({
            contactName: call.name,
            type: "outbound",
            notes: call.outcome
              ? `[Scanned Sheet] ${call.outcome}`
              : "[Scanned Sheet] Call completed",
          });
          callResults.push(call.name);
        } catch (e) {
          console.warn("[sheet-scan] Call insert failed:", e);
        }
      }
    }

    // 7. Update DB — mark top-3 tasks completed
    const taskResults: number[] = [];
    for (const t of parsed.top3 ?? []) {
      if (t.checked) {
        try {
          await personalDb.execute(
            sql`INSERT INTO task_completions (task_id, task_text, completed_at)
                VALUES (${`scanned-top3-row${t.row}-${today}`}, ${`Top 3 #${t.row} — completed via scanned sheet${t.note ? `: ${t.note}` : ""}`}, NOW())
                ON CONFLICT DO NOTHING`
          );
          taskResults.push(t.row);
        } catch (e) {
          console.warn("[sheet-scan] Task completion insert failed:", e);
        }
      }
    }

    // 8. Mark the email as processed (archive) to avoid re-processing
    try {
      await agentMailRequest(`/v1/inboxes/${inbox.id}/messages/${targetMsg.id}`, {
        method: "PATCH",
        body: { archived: true },
      });
    } catch { /* best-effort */ }

    return res.json({
      ok: true,
      confidence: parsed.confidence ?? "unknown",
      callsLogged: callResults,
      tasksCompleted: taskResults,
      scratchNotes: parsed.scratch_notes ?? null,
      wins: (parsed.wins ?? []).filter(Boolean),
      raw: parsed,
    });
  } catch (err: unknown) {
    console.error("[sheet-scan/process]", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
