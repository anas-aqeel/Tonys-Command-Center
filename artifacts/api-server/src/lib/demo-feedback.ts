import { searchFiles } from "./google-drive";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { isAgentRuntimeEnabled } from "../agents/flags.js";
import { runAgent } from "../agents/runtime.js";

const RECORDINGS_FOLDER_ID = process.env.MEETING_RECORDINGS_FOLDER_ID || "1g1itXWZj82oudTpMSp96HCoKk79_ZkdX";

/**
 * Scan for demo recordings matching a calendar event and generate AI coaching feedback.
 * Returns the feedback text or null if no recording found.
 */
export async function analyzeDemoRecording(eventName: string, eventDate: string): Promise<string | null> {
  try {
    const searchTerm = eventName.replace(/flipiq demo/i, "").trim() || eventDate;
    const recordings = await searchFiles({
      folderId: RECORDINGS_FOLDER_ID,
      nameContains: searchTerm,
      maxResults: 5,
    });

    if (recordings.length === 0) {
      console.log(`[demo-feedback] No recording found for "${eventName}" on ${eventDate}`);
      return null;
    }

    const recording = recordings[0];
    console.log(`[demo-feedback] Found recording: ${recording.name}`);

    let transcriptContent = "";
    try {
      const { getDrive } = await import("./google-auth");
      const drive = getDrive();
      const exported = await drive.files.export({
        fileId: recording.id,
        mimeType: "text/plain",
      });
      transcriptContent = typeof exported.data === "string" ? exported.data : JSON.stringify(exported.data);
    } catch {
      console.log(`[demo-feedback] Could not export transcript, using metadata-only analysis`);
    }

    const userPrompt = `A FlipIQ demo was conducted: "${eventName}" on ${eventDate}. Recording found: "${recording.name}".
${transcriptContent ? `\nTRANSCRIPT:\n${transcriptContent.substring(0, 8000)}` : "(No transcript available — metadata-only analysis.)"}

Generate concise coaching feedback for Tony covering:
1. Talk-to-listen ratio (aim for 60% prospect talking)${transcriptContent ? " — compute from transcript" : ""}
2. Questions asked${transcriptContent ? " — count from transcript" : ""}
3. Prospect engagement signals${transcriptContent ? " — identify from transcript" : ""}
4. Objections raised${transcriptContent ? " — extract from transcript" : ""}
5. Follow-up timing recommendation

Keep it actionable and under 300 words.`;

    let analysisText: string | null = null;

    // Flag-gated: AGENT_RUNTIME_INGEST=true routes through runtime.
    // Runtime path: send only event data; coaching framework in skill body.
    if (isAgentRuntimeEnabled("ingest")) {
      const runtimeMessage = `Demo: "${eventName}" on ${eventDate}. Recording: "${recording.name}".${transcriptContent ? `\n\nTRANSCRIPT:\n${transcriptContent.substring(0, 8000)}` : "\n\n(No transcript available — metadata-only analysis.)"}`;
      const result = await runAgent("ingest", "analyze-demo-feedback", {
        userMessage: runtimeMessage,
        caller: "direct",
        meta: { eventName, eventDate, hasTranscript: !!transcriptContent },
      });
      analysisText = result.text || null;
    } else {
      const feedback = await createTrackedMessage("demo_feedback", {
        model: "claude-haiku-4-5",
        max_tokens: 500,
        messages: [{ role: "user", content: userPrompt }],
      });
      const textBlock = feedback.content.find(b => b.type === "text");
      analysisText = textBlock?.type === "text" ? textBlock.text : null;
    }

    if (analysisText) {
      try {
        const { sharedDb } = await import("@workspace/db");
        const { communicationLogTable } = await import("./schema-v2");
        await sharedDb.insert(communicationLogTable).values({
          contactName: eventName.replace(/flipiq demo/i, "").trim() || "Demo participant",
          channel: "meeting",
          direction: "outbound",
          subject: eventName,
          summary: analysisText.substring(0, 300),
          fullContent: analysisText,
        });
      } catch { /* non-critical */ }
    }

    return analysisText;
  } catch (err) {
    console.warn("[demo-feedback] Analysis failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
