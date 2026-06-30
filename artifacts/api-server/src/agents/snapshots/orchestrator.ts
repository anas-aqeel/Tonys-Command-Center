// Orchestrator feedback snapshot — for chat thumbs / classification corrections.

import { personalDb, chatThreadsTable, chatMessagesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function captureOrchestratorSnapshot(
  skill: string,
  sourceId: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // sourceId is a chat_messages.id (the message the user reacted to)
  let message: any = null;
  let thread: any = null;
  let recentMessages: any[] = [];

  if (sourceId && /^[0-9a-f-]{36}$/i.test(sourceId)) {
    const [m] = await personalDb.select().from(chatMessagesTable)
      .where(eq(chatMessagesTable.id, sourceId))
      .limit(1);
    message = m || null;

    if (message?.threadId) {
      const [t] = await personalDb.select().from(chatThreadsTable)
        .where(eq(chatThreadsTable.id, message.threadId))
        .limit(1);
      thread = t || null;

      // Last 6 messages on the thread for context
      recentMessages = await personalDb.select({
        role: chatMessagesTable.role,
        content: chatMessagesTable.content,
        createdAt: chatMessagesTable.createdAt,
      }).from(chatMessagesTable)
        .where(eq(chatMessagesTable.threadId, message.threadId))
        .orderBy(desc(chatMessagesTable.createdAt))
        .limit(6);
    }
  }

  return {
    message: message ? {
      id: message.id,
      role: message.role,
      content: message.content,
      tool_calls: message.toolCalls,
      created_at: message.createdAt,
    } : null,
    thread: thread ? {
      id: thread.id,
      title: thread.title,
      context_type: thread.contextType,
    } : null,
    thread_recent_messages: recentMessages,
    user_message_classified_as: extra?.classifiedAs || null,
    delegated_to: extra?.delegatedTo || null,
    extra: extra || null,
  };
}
