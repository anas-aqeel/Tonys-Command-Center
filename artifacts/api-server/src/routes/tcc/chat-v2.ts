// Chat v2 — orchestrator-driven chat (Phase 2).
//
// Wires Tony's chat UI to the new agent runtime. Same persistence (chat_threads,
// chat_messages) as the legacy claude.ts route — only the AI call path changes.
//
// Behavior:
//   - When AGENT_RUNTIME_ORCHESTRATOR=true, this route should be called instead
//     of POST /chat/:threadId/messages (the legacy 42-tool monolith). For now
//     this route exists alongside; FE can A/B by sending to /api/v2/...
//   - Reads thread + recent messages, calls runAgent('orchestrator', 'direct', ...)
//     with the latest user turn as userMessage and the runtime resolves the 40
//     orchestrator tools (Slack/Linear/Calendar/Gmail/Drive/etc.) declared on
//     the skill.
//   - Persists assistant response back into chat_messages.
//
// Auto-title (first message in thread): runs after response is persisted, calls
// runAgent('orchestrator', 'auto-title', ...) to populate chat_threads.title.

import { Router, type IRouter } from "express";
import { z } from "zod";
import { personalDb, chatThreadsTable, chatMessagesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { runAgent } from "../../agents/runtime.js";
import { isAgentRuntimeEnabled } from "../../agents/flags.js";

const router: IRouter = Router();

const PostBody = z.object({
  content: z.string().min(1),
});

router.post("/v2/chat/threads/:threadId/messages", async (req, res): Promise<void> => {
  const threadId = req.params.threadId;
  if (!threadId) { res.status(400).json({ error: "threadId required" }); return; }

  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  if (!isAgentRuntimeEnabled("orchestrator")) {
    res.status(503).json({
      error: "orchestrator runtime is disabled",
      hint: "Set AGENT_RUNTIME_ORCHESTRATOR=true to enable; legacy /chat path still works.",
    });
    return;
  }

  const userText = parsed.data.content;

  // Verify the thread exists.
  const [thread] = await personalDb.select().from(chatThreadsTable)
    .where(eq(chatThreadsTable.id, threadId))
    .limit(1);
  if (!thread) { res.status(404).json({ error: "thread not found" }); return; }

  // Persist the user turn first so it's reflected even if AI fails.
  await personalDb.insert(chatMessagesTable).values({
    threadId,
    role: "user",
    content: userText,
  });

  try {
    const result = await runAgent("orchestrator", "direct", {
      userMessage: userText,
      caller: "orchestrator",
      callerThreadId: threadId,
      meta: { route: "chat-v2" },
    });

    // Persist the assistant turn (text only — tool_calls captured in agent_runs).
    const [assistantRow] = await personalDb.insert(chatMessagesTable).values({
      threadId,
      role: "assistant",
      content: result.text,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : null,
    }).returning({ id: chatMessagesTable.id });

    // Bump thread updatedAt
    await personalDb.update(chatThreadsTable)
      .set({ updatedAt: new Date() })
      .where(eq(chatThreadsTable.id, threadId))
      .catch(() => { /* non-critical */ });

    // Auto-title the thread if it doesn't have one yet.
    let titleGenerated: string | null = null;
    if (!thread.title) {
      try {
        const titleResult = await runAgent("orchestrator", "auto-title", {
          userMessage: `Generate a 3-6 word title for a chat thread that started with this message:\n\n"${userText}"\n\nReturn only the title text — no quotes, no markdown.`,
          caller: "orchestrator",
          callerThreadId: threadId,
          meta: { route: "chat-v2-title" },
          maxTokensOverride: 60,
        });
        titleGenerated = titleResult.text.trim().slice(0, 80);
        if (titleGenerated) {
          await personalDb.update(chatThreadsTable)
            .set({ title: titleGenerated })
            .where(eq(chatThreadsTable.id, threadId));
        }
      } catch { /* title is optional */ }
    }

    res.json({
      ok: true,
      message_id: assistantRow?.id,
      content: result.text,
      tool_calls: result.toolCalls,
      turns: result.turns,
      run_id: result.runId,
      title: titleGenerated || thread.title,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Persist a brief error as the assistant turn so the UI shows something
    await personalDb.insert(chatMessagesTable).values({
      threadId,
      role: "assistant",
      content: `(orchestrator error: ${errMsg.slice(0, 200)})`,
    }).catch(() => { /* non-critical */ });
    res.status(500).json({ error: errMsg });
  }
});

export default router;
