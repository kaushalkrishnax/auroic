import { eq } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { chats, chatParticipants, messages } from "@/db/schema.js";
import type { SelectChat, SelectChatParticipant } from "@/db/schema.js";
import type { RawIGThread, RawIGUser } from "@/types/index.js";

export function ensureChatExists(chatId: string): void {
  getDB().insert(chats).values({ chatId }).onConflictDoNothing().run();
}

export function createChat(thread: RawIGThread): void {
  const db = getDB();
  db.insert(chats)
    .values({
      chatId: thread.thread_fbid,
      title: thread.thread_title ?? null,
      imageUrl: thread.thread_image_url ?? null,
      groupCreatorId: thread.group_creator?.interop_messaging_user_fbid ?? null,
      isGroup: thread.is_group ?? false,
      isMuted: thread.is_muted ?? false,
    })
    .onConflictDoUpdate({
      target: chats.chatId,
      set: {
        title: thread.thread_title ?? null,
        imageUrl: thread.thread_image_url ?? null,
        groupCreatorId:
          thread.group_creator?.interop_messaging_user_fbid ?? null,
        isGroup: thread.is_group ?? false,
        isMuted: thread.is_muted ?? false,
      },
    })
    .run();
}

export function getChatById(chatId: string): SelectChat | undefined {
  return getDB().select().from(chats).where(eq(chats.chatId, chatId)).get();
}

export function getAllChats(): SelectChat[] {
  return getDB().select().from(chats).all();
}

export function createChatParticipants(
  chatId: string,
  rawUsers: RawIGUser[],
): void {
  if (rawUsers.length === 0) return;
  const db = getDB();
  const rows = rawUsers.map((u) => ({
    chatId,
    senderFbid: u.interop_messaging_user_fbid,
  }));
  db.insert(chatParticipants).values(rows).onConflictDoNothing().run();
}

export function getChatParticipants(chatId: string): SelectChatParticipant[] {
  return getDB()
    .select()
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chatId))
    .all();
}

export function getLastProcessedMid(chatId: string): string | null {
  const row = getDB()
    .select({ lastProcessedMid: chats.lastProcessedMid })
    .from(chats)
    .where(eq(chats.chatId, chatId))
    .get();
  return row?.lastProcessedMid ?? null;
}

export function setLastProcessedMid(chatId: string, mid: string): void {
  getDB()
    .update(chats)
    .set({ lastProcessedMid: mid })
    .where(eq(chats.chatId, chatId))
    .run();
}
