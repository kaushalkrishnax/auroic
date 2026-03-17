import { eq, and, desc } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { messages } from "@/db/schema.js";
import type { SelectMessage, InsertMessage } from "@/db/schema.js";

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
  const whereClause = includeDeleted
    ? eq(messages.conversationId, conversationId)
    : and(
        eq(messages.conversationId, conversationId),
        eq(messages.isDeleted, false),
      );

  const rows = getDB()
    .select()
    .from(messages)
    .where(whereClause)
    .orderBy(desc(messages.timestampMs))
    .limit(limit)
    .all();
  return rows.reverse();
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

export type { SelectMessage, InsertMessage };
