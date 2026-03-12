import { eq } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { conversations, conversationParticipants } from "@/db/schema.js";
import type {
  SelectConversation,
  SelectConversationParticipant,
} from "@/db/schema.js";
import type { RawIGThread, RawIGUser } from "@/types/index.js";

export function ensureConversationExists(conversationId: string): void {
  getDB()
    .insert(conversations)
    .values({ conversationId: conversationId, platform: "instagram" })
    .onConflictDoNothing()
    .run();
}

export function createConversation(thread: RawIGThread): void {
  const db = getDB();
  db.insert(conversations)
    .values({
      conversationId: thread.thread_fbid,
      platform: "instagram",
      title: thread.thread_title ?? null,
      avatarUrl: thread.thread_image_url ?? null,
      createdByUserId:
        thread.group_creator?.interop_messaging_user_fbid ?? null,
      isGroup: thread.is_group ?? false,
      isMuted: thread.is_muted ?? false,
    })
    .onConflictDoUpdate({
      target: conversations.conversationId,
      set: {
        title: thread.thread_title ?? null,
        avatarUrl: thread.thread_image_url ?? null,
        createdByUserId:
          thread.group_creator?.interop_messaging_user_fbid ?? null,
        isGroup: thread.is_group ?? false,
        isMuted: thread.is_muted ?? false,
      },
    })
    .run();
}

export function getConversationById(
  conversationId: string,
): SelectConversation | undefined {
  return getDB()
    .select()
    .from(conversations)
    .where(eq(conversations.conversationId, conversationId))
    .get();
}

export function getAllConversations(): SelectConversation[] {
  return getDB().select().from(conversations).all();
}

export function createConversationParticipants(
  conversationId: string,
  rawUsers: RawIGUser[],
): void {
  if (rawUsers.length === 0) return;
  const db = getDB();
  const rows = rawUsers.map((u) => ({
    conversationId: conversationId,
    userId: u.interop_messaging_user_fbid,
  }));
  db.insert(conversationParticipants).values(rows).onConflictDoNothing().run();
}

export function getConversationParticipants(
  conversationId: string,
): SelectConversationParticipant[] {
  return getDB()
    .select()
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, conversationId))
    .all();
}

export function getLastProcessedMessageId(
  conversationId: string,
): string | null {
  const row = getDB()
    .select({
      lastProcessedMessageId: conversations.lastProcessedMessageId,
    })
    .from(conversations)
    .where(eq(conversations.conversationId, conversationId))
    .get();
  return row?.lastProcessedMessageId ?? null;
}

export function setLastProcessedMessageId(
  conversationId: string,
  messageId: string,
): void {
  getDB()
    .update(conversations)
    .set({ lastProcessedMessageId: messageId })
    .where(eq(conversations.conversationId, conversationId))
    .run();
}
