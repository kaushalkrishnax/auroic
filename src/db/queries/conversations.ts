import { eq, desc, sql } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { messages, conversations, conversationParticipants } from "@/db/schema.js";
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

export function getStartupConversationIds(
  configuredChatIds: string[],
): string[] {
  const db = getDB();

  const latestByConversation = db
    .select({
      conversationId: messages.conversationId,
      latestTimestampMs: sql<number>`max(${messages.timestampMs})`,
    })
    .from(messages)
    .groupBy(messages.conversationId)
    .all();

  const latestMap = new Map<string, number>();
  for (const row of latestByConversation) {
    if (!row.conversationId) continue;
    latestMap.set(
      row.conversationId,
      Number.isFinite(row.latestTimestampMs)
        ? Number(row.latestTimestampMs)
        : 0,
    );
  }

  const dbConversations = db
    .select({
      conversationId: conversations.conversationId,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .orderBy(desc(conversations.createdAt))
    .all();

  const orderedDbIds = dbConversations
    .slice()
    .sort((a, b) => {
      const latestA = latestMap.get(a.conversationId) ?? 0;
      const latestB = latestMap.get(b.conversationId) ?? 0;
      if (latestA !== latestB) return latestB - latestA;

      const createdA = String(a.createdAt ?? "");
      const createdB = String(b.createdAt ?? "");
      return createdB.localeCompare(createdA);
    })
    .map((row) => String(row.conversationId || "").trim())
    .filter(Boolean);

  const configuredIds = configuredChatIds
    .map((id) => String(id || "").trim())
    .filter(Boolean);

  return [...new Set([...orderedDbIds, ...configuredIds])];
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
