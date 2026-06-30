import { searchFiles } from "./google-drive";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { isAgentRuntimeEnabled } from "../agents/flags.js";
import { runAgent } from "../agents/runtime.js";
import { sharedDb } from "@workspace/db";
import { communicationLogTable, contactIntelligenceTable } from "./schema-v2";
import { eq, ilike } from "drizzle-orm";

const RECORDINGS_FOLDER_ID = "1g1itXWZj82oudTpMSp96HCoKk79_ZkdX";

export interface PlaudAnalysis {
  fileName: string;
  fileId: string;
  contactName: string;
  talkListenRatio: string;
  questionsAsked: number;
  prospectInterestLevel: "high" | "medium" | "low";
  interestSignals: string[];
  objections: string[];
  followUpRecommendation: string;
  summary: string;
  fullAnalysis: string;
}

/**
 * Scan the Plaud recordings folder and analyze any transcripts found.
 * Returns an array of analysis results (one per transcript found).
 */
export async function processPlaudRecordings(opts: {
  nameContains?: string;
  maxResults?: number;
  sinceDate?: Date;
} = {}): Promise<PlaudAnalysis[]> {
  const recordings = await searchFiles({
    folderId: RECORDINGS_FOLDER_ID,
    nameContains: opts.nameContains,
    maxResults: opts.maxResults ?? 10,
  });

  if (recordings.length === 0) {
    console.log("[plaud-processor] No recordings found in folder");
    return [];
  }

  const results: PlaudAnalysis[] = [];

  for (const recording of recordings) {
    try {
      const analysis = await analyzeRecording(recording.id, recording.name);
      if (analysis) results.push(analysis);
    } catch (err) {
      console.warn(`[plaud-processor] Failed to analyze ${recording.name}:`, err instanceof Error ? err.message : err);
    }
  }

  return results;
}

/**
 * Analyze a single recording file from Google Drive.
 * Extracts transcript text, runs Claude analysis, saves to DB.
 */
export async function analyzeRecording(fileId: string, fileName: string): Promise<PlaudAnalysis | null> {
  let transcriptContent = "";
  try {
    const { getDrive } = await import("./google-auth");
    const drive = getDrive();

    // First, try to export as Google Doc (text/plain)
    try {
      const exported = await drive.files.export({ fileId, mimeType: "text/plain" });
      transcriptContent = typeof exported.data === "string" ? exported.data : JSON.stringify(exported.data);
    } catch {
      // If export fails (e.g., not a Google Doc format), try downloading raw content
      try {
        const downloaded = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
        transcriptContent = typeof downloaded.data === "string" ? downloaded.data : "";
        console.log(`[plaud-processor] Downloaded raw content for ${fileName} (${transcriptContent.length} chars)`);
      } catch (downloadErr) {
        console.log(`[plaud-processor] Could not download ${fileName}: ${downloadErr instanceof Error ? downloadErr.message : downloadErr}`);
      }
    }

    if (!transcriptContent) {
      console.log(`[plaud-processor] No transcript text obtained for ${fileName} — proceeding with metadata-only analysis`);
    } else {
      console.log(`[plaud-processor] Got transcript for ${fileName} (${transcriptContent.length} chars)`);
    }
  } catch (err) {
    console.log(`[plaud-processor] Drive access failed for ${fileName}: ${err instanceof Error ? err.message : err}`);
  }

  const contactName = extractContactName(fileName);

  const prompt = `You are analyzing a sales call or meeting recording for Tony Diaz (FlipIQ CEO).
File: "${fileName}"
Contact: "${contactName}"
${transcriptContent ? `\nTRANSCRIPT (excerpt):\n${transcriptContent.substring(0, 10000)}` : "(No transcript text — metadata-only analysis.)"}

Analyze this call and respond in the following JSON format ONLY (no other text):
{
  "talkListenRatio": "<e.g. Tony: 45% / Prospect: 55%>",
  "questionsAsked": <number>,
  "prospectInterestLevel": "<high|medium|low>",
  "interestSignals": ["<signal 1>", "<signal 2>"],
  "objections": ["<objection 1>"],
  "followUpRecommendation": "<what Tony should do next and when>",
  "summary": "<2-3 sentence overview of the call>"
}`;

  let analysisData: Omit<PlaudAnalysis, "fileName" | "fileId" | "contactName" | "fullAnalysis">;
  let rawText = "";

  try {
    // Flag-gated: AGENT_RUNTIME_INGEST=true routes through runtime.
    // Runtime path: send only call data; analysis spec/format in skill body.
    if (isAgentRuntimeEnabled("ingest")) {
      const runtimeMessage = `File: "${fileName}"\nContact: "${contactName}"${transcriptContent ? `\n\nTRANSCRIPT (excerpt):\n${transcriptContent.substring(0, 10000)}` : "\n\n(No transcript text — metadata-only analysis.)"}`;
      const result = await runAgent("ingest", "transcribe-plaud", {
        userMessage: runtimeMessage,
        caller: "direct",
      });
      rawText = result.text;
    } else {
      const response = await createTrackedMessage("plaud_transcribe", {
        model: "claude-haiku-4-5",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      });
      const textBlock = response.content.find(b => b.type === "text");
      rawText = textBlock?.type === "text" ? textBlock.text : "";
    }

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      analysisData = {
        talkListenRatio: String(parsed.talkListenRatio || "Unknown"),
        questionsAsked: Number(parsed.questionsAsked ?? 0),
        prospectInterestLevel: (parsed.prospectInterestLevel === "high" || parsed.prospectInterestLevel === "low") ? parsed.prospectInterestLevel : "medium",
        interestSignals: Array.isArray(parsed.interestSignals) ? parsed.interestSignals.map(String) : [],
        objections: Array.isArray(parsed.objections) ? parsed.objections.map(String) : [],
        followUpRecommendation: String(parsed.followUpRecommendation || ""),
        summary: String(parsed.summary || ""),
      };
    } else {
      analysisData = {
        talkListenRatio: "Analysis unavailable",
        questionsAsked: 0,
        prospectInterestLevel: "medium",
        interestSignals: [],
        objections: [],
        followUpRecommendation: "Review recording manually",
        summary: rawText.substring(0, 300),
      };
    }
  } catch (err) {
    console.warn("[plaud-processor] Claude analysis failed:", err instanceof Error ? err.message : err);
    return null;
  }

  const result: PlaudAnalysis = {
    fileName,
    fileId,
    contactName,
    fullAnalysis: rawText,
    ...analysisData,
  };

  await saveToDatabase(result);

  return result;
}

/**
 * Attempt to extract a contact/prospect name from the recording file name.
 * Plaud typically names files like "John Smith 2026-04-04" or "FlipIQ - AcmeCorp call".
 */
function extractContactName(fileName: string): string {
  const cleaned = fileName
    .replace(/\.\w+$/, "")
    .replace(/\d{4}-\d{2}-\d{2}/g, "")
    .replace(/flipiq/gi, "")
    .replace(/demo|call|meeting|recording|plaud/gi, "")
    .replace(/[-_]/g, " ")
    .trim();
  return cleaned || "Unknown Prospect";
}

/**
 * Save analysis results to communication_log and update contact_intelligence.
 */
async function saveToDatabase(analysis: PlaudAnalysis): Promise<void> {
  const fullContent = [
    `File: ${analysis.fileName}`,
    `Talk/Listen: ${analysis.talkListenRatio}`,
    `Questions Asked: ${analysis.questionsAsked}`,
    `Prospect Interest: ${analysis.prospectInterestLevel}`,
    `Interest Signals: ${analysis.interestSignals.join(", ") || "None noted"}`,
    `Objections: ${analysis.objections.join(", ") || "None"}`,
    `Follow-up: ${analysis.followUpRecommendation}`,
    "",
    analysis.summary,
  ].join("\n");

  try {
    await sharedDb.insert(communicationLogTable).values({
      contactName: analysis.contactName,
      channel: "plaud_recording",
      direction: "outbound",
      subject: `Plaud Recording: ${analysis.fileName}`,
      summary: analysis.summary.substring(0, 300),
      fullContent,
      sentiment: analysis.prospectInterestLevel === "high" ? "positive" : analysis.prospectInterestLevel === "low" ? "negative" : "neutral",
      plaudTranscriptPath: analysis.fileId,
      actionItems: analysis.followUpRecommendation ? [analysis.followUpRecommendation] : [],
    });
    console.log(`[plaud-processor] Saved to communication_log for ${analysis.contactName}`);
  } catch (err) {
    console.warn("[plaud-processor] Failed to save to communication_log:", err instanceof Error ? err.message : err);
  }

  // Update contact_intelligence if we can find a matching contact
  try {
    const { contactsTable } = await import("@workspace/db");
    const [contact] = await sharedDb
      .select()
      .from(contactsTable)
      .where(ilike(contactsTable.name, `%${analysis.contactName.split(" ")[0]}%`))
      .limit(1);

    if (contact) {
      const [existing] = await sharedDb
        .select()
        .from(contactIntelligenceTable)
        .where(eq(contactIntelligenceTable.contactId, contact.id))
        .limit(1);

      if (existing) {
        await sharedDb
          .update(contactIntelligenceTable)
          .set({
            totalCalls: (existing.totalCalls ?? 0) + 1,
            lastCommunicationDate: new Date(),
            lastCommunicationType: "plaud_recording",
            lastCommunicationSummary: analysis.summary.substring(0, 300),
            personalityNotes: [
              existing.personalityNotes,
              `[${new Date().toLocaleDateString()}] Interest: ${analysis.prospectInterestLevel}. ${analysis.interestSignals.slice(0, 2).join(", ")}`,
            ].filter(Boolean).join("\n"),
          })
          .where(eq(contactIntelligenceTable.contactId, contact.id));
      } else {
        await sharedDb.insert(contactIntelligenceTable).values({
          contactId: contact.id,
          totalCalls: 1,
          lastCommunicationDate: new Date(),
          lastCommunicationType: "plaud_recording",
          lastCommunicationSummary: analysis.summary.substring(0, 300),
          personalityNotes: `[${new Date().toLocaleDateString()}] Interest: ${analysis.prospectInterestLevel}. ${analysis.interestSignals.slice(0, 2).join(", ")}`,
        });
      }
      console.log(`[plaud-processor] Updated contact_intelligence for contact ${contact.id}`);
    }
  } catch (err) {
    console.warn("[plaud-processor] Failed to update contact_intelligence:", err instanceof Error ? err.message : err);
  }
}
