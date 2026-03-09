import { eq, and, desc, ne, isNull, isNotNull } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { messages } from "@/db/schema.js";
import type { SelectMessage, InsertMessage } from "@/db/schema.js";
import { sql } from "drizzle-orm";

export interface IncomingMessageInput {
  mid: string;
  chatId: string;
  senderFbid: string;
  timestampMs: number;
  contentType?: string | null;
  textBody?: string | null;
  repliedToMid?: string | null;
}

/** Returns the inserted row id, or null if the message already existed. */
export function insertIncomingMessage(
  msg: IncomingMessageInput,
): number | null {
  const db = getDB();
  const result = db
    .insert(messages)
    .values({
      mid: msg.mid,
      chatId: msg.chatId,
      senderFbid: msg.senderFbid,
      timestampMs: msg.timestampMs,
      contentType: msg.contentType ?? null,
      textBody: msg.textBody ?? null,
      repliedToMid: msg.repliedToMid ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id })
    .get();

  return result?.id ?? null;
}

export function editMessage(mid: string, newText: string): void {
  getDB()
    .update(messages)
    .set({ textBody: newText, edited: true })
    .where(eq(messages.mid, mid))
    .run();
}

export function markMessageDeleted(mid: string): void {
  getDB()
    .update(messages)
    .set({ deleted: true })
    .where(eq(messages.mid, mid))
    .run();
}

/** Returns a single message by its mid. */
export function getMessageByMid(mid: string): SelectMessage | undefined {
  return getDB()
    .select()
    .from(messages)
    .where(eq(messages.mid, mid))
    .limit(1)
    .get();
}

/** Returns last N non-deleted messages for a chat, oldest first. */
export function getLatestMessages(chatId: string, limit = 5): SelectMessage[] {
  const rows = getDB()
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.deleted, false)))
    .orderBy(desc(messages.timestampMs))
    .limit(limit)
    .all();
  return rows.reverse();
}

/**
 * Returns last N non-deleted, unprocessed, non-bot messages for building
 * the router sliding window. Ordered oldest-first.
 */
export function getWindowMessages(
  chatId: string,
  botId: string,
  limit = 5,
): SelectMessage[] {
  const rows = getDB()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.deleted, false),
      ),
    )
    .orderBy(desc(messages.timestampMs))
    .limit(limit)
    .all();
  return rows.reverse();
}

/** Returns the newest non-deleted, unprocessed, unlocked message with text body not sent by botId. */
export function getNewestIncomingTextMessage(
  chatId: string,
  botId: string,
): SelectMessage | undefined {
  if (!botId) return undefined;
  return getDB()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        ne(messages.senderFbid, botId),
        isNotNull(messages.textBody),
        eq(messages.deleted, false),
        isNull(messages.processedAt),
        isNull(messages.processingLockAt),
      ),
    )
    .orderBy(desc(messages.timestampMs))
    .limit(1)
    .get();
}

/** Returns all messages, optionally filtered by chatId. */
export function getAllMessages(chatId?: string, limit = 100): SelectMessage[] {
  const db = getDB();
  if (chatId) {
    return db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
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
export function lockMessage(mid: string): void {
  getDB()
    .update(messages)
    .set({ processingLockAt: sql`(datetime('now'))` })
    .where(eq(messages.mid, mid))
    .run();
}

/** Marks a message as processed and releases the lock. */
export function markMessageProcessed(mid: string): void {
  getDB()
    .update(messages)
    .set({
      processedAt: sql`(datetime('now'))`,
      processingLockAt: null,
    })
    .where(eq(messages.mid, mid))
    .run();
}

/** Releases the processing lock on a message (for retry after failure). */
export function unlockMessage(mid: string): void {
  getDB()
    .update(messages)
    .set({ processingLockAt: null })
    .where(eq(messages.mid, mid))
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

/** Returns all unprocessed messages for a chat (processed_at IS NULL), excluding bot messages. */
export function getUnprocessedMessages(
  chatId: string,
  botId: string,
): SelectMessage[] {
  if (!botId) return [];
  return getDB()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        ne(messages.senderFbid, botId),
        isNotNull(messages.textBody),
        eq(messages.deleted, false),
        isNull(messages.processedAt),
      ),
    )
    .orderBy(desc(messages.timestampMs))
    .all();
}

export type { SelectMessage, InsertMessage };
