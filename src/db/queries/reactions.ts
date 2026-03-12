import { eq, desc } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { messageReactions } from "@/db/schema.js";
import type {
  SelectMessageReaction,
  InsertMessageReaction,
} from "@/db/schema.js";

export interface ReactionInput {
  messageId: string;
  userId: string;
  reaction: string;
  timestampMs?: number | null;
}

export function insertReaction(input: ReactionInput): void {
  getDB()
    .insert(messageReactions)
    .values({
      messageId: input.messageId,
      userId: input.userId,
      reaction: input.reaction,
      timestampMs: input.timestampMs ?? null,
    })
    .run();
}

export function deleteReaction(messageId: string): void {
  getDB()
    .delete(messageReactions)
    .where(eq(messageReactions.messageId, messageId))
    .run();
}

export function getReactionsForMessage(
  messageId: string,
): SelectMessageReaction[] {
  return getDB()
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.messageId, messageId))
    .all();
}

export function getAllReactions(limit = 200): SelectMessageReaction[] {
  return getDB()
    .select()
    .from(messageReactions)
    .orderBy(desc(messageReactions.id))
    .limit(limit)
    .all();
}

export type {
  SelectMessageReaction as SelectReaction,
  InsertMessageReaction as InsertReaction,
};
