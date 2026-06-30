import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { personalDb, journalsTable, checkinsTable } from "@workspace/db";
import { SaveJournalBody } from "@workspace/api-zod";
import { anthropic, createTrackedMessage } from "@workspace/integrations-anthropic-ai";
import { todayPacific } from "../../lib/dates.js";
import { appendToDoc } from "../../lib/google-docs.js";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";
import { runAgent } from "../../agents/runtime.js";

const JOURNAL_DOC_ID = process.env.JOURNAL_DOC_ID || "";

const router: IRouter = Router();

router.get("/journal/today", async (req, res): Promise<void> => {
  const today = todayPacific();
  const [journal] = await personalDb
    .select()
    .from(journalsTable)
    .where(eq(journalsTable.date, today));

  if (!journal) {
    res.json({ id: null, date: today, rawText: null, formattedText: null, mood: null, keyEvents: null, reflection: null });
    return;
  }

  res.json(journal);
});

router.post("/journal", async (req, res): Promise<void> => {
  const parsed = SaveJournalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const today = todayPacific();
  const todayDate = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
  const rawText = parsed.data.rawText;

  let formattedText = rawText;
  let mood = "";
  let keyEvents = "";
  let reflection = "";

  try {
    let aiText = "";

    // Flag-gated: AGENT_RUNTIME_JOURNAL=true routes through runtime;
    // default false keeps legacy inline prompt intact.
    if (isAgentRuntimeEnabled("journal")) {
      // v2 journal/format-entry skill is designed as a "save + confirm" tool-using
      // agent and returns just "Entry saved. <date>." by default. This route still
      // needs the legacy formatted markdown (Mood / Key Events / Reflection
      // sections) for downstream regex extraction + DB save, so spell the
      // expected output explicitly in the user prompt.
      const userMessage = `Today is ${todayDate}.

Raw entry:
${rawText}

Do NOT call any save tools. Just output the formatted entry as markdown in EXACTLY this structure (start with \`### Daily Journal Entry — ${todayDate}\`):

### Daily Journal Entry — ${todayDate}

**Mood:**
[2-4 emotion words extracted from content]

**Key Events:**
[Bullet points of what happened, who he talked to, decisions made]

**Physical/Health Notes:**
[Extracted from content. If nothing mentioned: "No specific health concerns noted today."]

**Reflection:**
[1-2 paragraph reflection connecting content to growth themes, PSI principles, and spiritual journey. Written in second or third person analytical voice, NOT Tony's voice.]

---

**Original Entry (cleaned up):**
[Tony's raw voice-to-text, cleaned for readability — fix grammar, remove filler words, but keep his voice and meaning]`;

      const result = await runAgent("journal", "format-entry", {
        userMessage,
        caller: "direct",
        meta: { date: today },
      });
      aiText = result.text;
    } else {
      const message = await createTrackedMessage("journal_format", {
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        messages: [
          {
            role: "user",
            content: `Format this journal entry from Tony Diaz into his exact journal structure. Today is ${todayDate}.

Raw entry:
${rawText}

Output EXACTLY this format and nothing else (start immediately with ### Daily Journal Entry):
### Daily Journal Entry — ${todayDate}

**Mood:**
[2-4 emotion words extracted from content]

**Key Events:**
[Bullet points of what happened, who he talked to, decisions made]

**Physical/Health Notes:**
[Extracted from content. If nothing mentioned: "No specific health concerns noted today."]

**Reflection:**
[1-2 paragraph reflection connecting content to growth themes, PSI principles, and spiritual journey. Written in second or third person analytical voice, NOT Tony's voice.]

---

**Original Entry (cleaned up):**
[Tony's raw voice-to-text, cleaned for readability — fix grammar, remove filler words, but keep his voice and meaning]`,
          },
        ],
      });
      const block = message.content[0];
      if (block.type === "text") aiText = block.text;
    }

    if (aiText) {
      formattedText = aiText;

      const moodMatch = formattedText.match(/\*\*Mood:\*\*\s*\n([^\n]+)/);
      if (moodMatch) mood = moodMatch[1].trim();

      const keyEventsMatch = formattedText.match(/\*\*Key Events:\*\*\s*\n([\s\S]+?)(?=\n\*\*)/);
      if (keyEventsMatch) keyEvents = keyEventsMatch[1].trim();

      const reflectionMatch = formattedText.match(/\*\*Reflection:\*\*\s*\n([\s\S]+?)(?=\n---)/);
      if (reflectionMatch) reflection = reflectionMatch[1].trim();
    }
  } catch (err) {
    req.log.warn({ err }, "Claude API failed, saving raw text");
  }

  // Check if today's journal already exists (to avoid duplicate Doc prepends on edit)
  const [existingJournal] = await personalDb.select({ id: journalsTable.id }).from(journalsTable).where(eq(journalsTable.date, today)).limit(1);
  const isEdit = !!existingJournal;

  // Use ON CONFLICT DO UPDATE to avoid select-then-insert race condition
  const [journal] = await personalDb
    .insert(journalsTable)
    .values({ date: today, rawText, formattedText, mood, keyEvents, reflection })
    .onConflictDoUpdate({
      target: journalsTable.date,
      set: { rawText, formattedText, mood, keyEvents, reflection },
    })
    .returning();

  // Mark journal complete on today's checkin (fire-and-forget, non-blocking)
  personalDb.update(checkinsTable)
    .set({ journal: true })
    .where(eq(checkinsTable.date, today))
    .catch(err => console.error("[journal] Failed to mark checkin journal=true:", err));

  // Append to Google Doc: always on first entry, retry if previous write failed
  const existingUrl = isEdit ? (await personalDb.select({ docsPageUrl: journalsTable.docsPageUrl }).from(journalsTable).where(eq(journalsTable.date, today)).limit(1))[0]?.docsPageUrl : null;
  const shouldWriteDoc = JOURNAL_DOC_ID && rawText !== "[skipped]" && formattedText && (!isEdit || !existingUrl);
  if (shouldWriteDoc) {
    // If AI formatting failed (no mood/keyEvents), wrap raw text in the standard format
    let docText = formattedText;
    if (!mood && !keyEvents && !reflection) {
      docText = `Daily Journal Entry — ${todayDate}\n\nMood:\n(AI unavailable)\n\nKey Events:\n• ${rawText}\n\nReflection:\n(AI unavailable — raw entry preserved above)\n\nOriginal Entry:\n${rawText}`;
    }
    // Add horizontal rule separator before entry
    const entryWithSeparator = "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" + docText + "\n";
    appendToDoc(JOURNAL_DOC_ID, entryWithSeparator)
      .then(() => {
        const docsUrl = `https://docs.google.com/document/d/${JOURNAL_DOC_ID}/edit`;
        personalDb.update(journalsTable).set({ docsPageUrl: docsUrl } as any).where(eq(journalsTable.date, today)).catch(() => {});
        console.log("[journal] Appended to Google Doc successfully");
      })
      .catch(err => console.error("[journal] Doc append failed (non-fatal):", err));
  }

  res.json(journal);
});

export default router;
