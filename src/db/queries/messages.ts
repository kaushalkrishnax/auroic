import { eq, and, desc, ne, isNull, isNotNull } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { messages } from "@/db/schema.js";
import type { SelectMessage, InsertMessage } from "@/db/schema.js";
import { sql } from "drizzle-orm";

export interface IncomingMessageInput {
  messageId: string;
  conversationId: string;
  userId: string;
  timestampMs: number;
  messageType?: string | null;
  textContent?: string | null;
  replyToMessageId?: string | null;
}

/** Returns the inserted row id, or null if the message already existed. */
export function insertIncomingMessage(
  msg: IncomingMessageInput,
): number | null {
  const db = getDB();
  const result = db
    .insert(messages)
    .values({
      messageId: msg.messageId,
      conversationId: msg.conversationId,
      userId: msg.userId,
      timestampMs: msg.timestampMs,
      messageType: msg.messageType ?? null,
      textContent: msg.textContent ?? null,
      replyToMessageId: msg.replyToMessageId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id })
    .get();

  return result?.id ?? null;
}

export function editMessage(messageId: string, newText: string): void {
  getDB()
    .update(messages)
    .set({ textContent: newText, isEdited: true })
    .where(eq(messages.messageId, messageId))
    .run();
}

export function markMessageDeleted(messageId: string): void {
  getDB()
    .update(messages)
    .set({ isDeleted: true })
    .where(eq(messages.messageId, messageId))
    .run();
}

/** Returns a single message by its message_id. */
export function getMessageByMid(messageId: string): SelectMessage | undefined {
  return getDB()
    .select()
    .from(messages)
    .where(eq(messages.messageId, messageId))
    .limit(1)
    .get();
}

/** Returns last N non-deleted messages for a conversation, oldest first. */
export function getLatestMessages(
  conversationId: string,
  limit = 5,
  includeDeleted = false,
): SelectMessage[] {
  const rows = getDB()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.isDeleted, includeDeleted ?? false),
      ),
    )
    .orderBy(desc(messages.timestampMs))
    .limit(limit)
    .all();
  return rows.reverse();
}

/**
 * Returns history (last N processed/bot messages) and candidates (unprocessed user messages, up to 3).
 * History is ordered oldest-first. Candidates are ordered oldest-first.
 */
export function getWindowMessages(
  conversationId: string,
  botId: string,
  historyLimit = 5,
): { history: SelectMessage[]; candidates: SelectMessage[] } {
  const allRecent = getLatestMessages(conversationId, historyLimit + 3);

  const candidates: SelectMessage[] = [];
  const history: SelectMessage[] = [];

  for (const m of allRecent) {
    if (!m.processedAt && m.userId !== botId && m.textContent) {
      candidates.push(m);
    } else {
      history.push(m);
    }
  }

  return {
    history: history.slice(-historyLimit),
    candidates: candidates.slice(0, 3),
  };
}

/** Returns the newest non-deleted, unprocessed, unlocked message with text not sent by botId. */
export function getNewestIncomingTextMessage(
  conversationId: string,
  botId: string,
): SelectMessage | undefined {
  if (!botId) return undefined;
  return getDB()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        ne(messages.userId, botId),
        isNotNull(messages.textContent),
        eq(messages.isDeleted, false),
        isNull(messages.processedAt),
        isNull(messages.processingLockAt),
      ),
    )
    .orderBy(desc(messages.timestampMs))
    .limit(1)
    .get();
}

/** Returns all messages, optionally filtered by conversationId. */
export function getAllMessages(
  conversationId?: string,
  limit = 100,
): SelectMessage[] {
  const db = getDB();
  if (conversationId) {
    return db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.timestampMs))
      .limit(limit)
      .all();
  }
  return db
    .select()
    .from(messages)
    .orderBy(desc(messages.timestampMs))
    .limit(limit)
    .all();
}

/** Locks a message for processing. */
export function lockMessage(messageId: string): void {
  getDB()
    .update(messages)
    .set({ processingLockAt: sql`(datetime('now'))` })
    .where(eq(messages.messageId, messageId))
    .run();
}

/** Marks a message as processed and releases the lock. */
export function markMessageProcessed(messageId: string): void {
  getDB()
    .update(messages)
    .set({
      processedAt: sql`(datetime('now'))`,
      processingLockAt: null,
    })
    .where(eq(messages.messageId, messageId))
    .run();
}

/** Releases the processing lock on a message (for retry after failure). */
export function unlockMessage(messageId: string): void {
  getDB()
    .update(messages)
    .set({ processingLockAt: null })
    .where(eq(messages.messageId, messageId))
    .run();
}

/** Clears stale processing locks older than the given timeout (in minutes). */
export function clearStaleLocks(timeoutMinutes = 2): number {
  const result = getDB()
    .update(messages)
    .set({ processingLockAt: null })
    .where(
      and(
        isNotNull(messages.processingLockAt),
        isNull(messages.processedAt),
        sql`datetime(${messages.processingLockAt}, '+${sql.raw(String(timeoutMinutes))} minutes') < datetime('now')`,
      ),
    )
    .run();
  return result.changes;
}

/** Returns all unprocessed messages for a conversation (processed_at IS NULL), excluding bot messages. */
export function getUnprocessedMessages(
  conversationId: string,
  botId: string,
): SelectMessage[] {
  if (!botId) return [];
  return getDB()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        ne(messages.userId, botId),
        isNotNull(messages.textContent),
        eq(messages.isDeleted, false),
        isNull(messages.processedAt),
      ),
    )
    .orderBy(desc(messages.timestampMs))
    .all();
}

export type { SelectMessage, InsertMessage };
