import { eq, desc } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { reactions } from "@/db/schema.js";
import type { SelectReaction, InsertReaction } from "@/db/schema.js";

export interface ReactionInput {
  messageMid: string;
  senderFbid: string;
  reaction: string;
  timestampMs?: number | null;
}

export function insertReaction(input: ReactionInput): void {
  getDB()
    .insert(reactions)
    .values({
      messageMid: input.messageMid,
      senderFbid: input.senderFbid,
      reaction: input.reaction,
      timestampMs: input.timestampMs ?? null,
    })
    .run();
}

export function deleteReaction(messageMid: string): void {
  getDB().delete(reactions).where(eq(reactions.messageMid, messageMid)).run();
}

export function getReactionsForMessage(messageMid: string): SelectReaction[] {
  return getDB()
    .select()
    .from(reactions)
    .where(eq(reactions.messageMid, messageMid))
    .all();
}

export function getAllReactions(limit = 200): SelectReaction[] {
  return getDB()
    .select()
    .from(reactions)
    .orderBy(desc(reactions.id))
    .limit(limit)
    .all();
}

export type { SelectReaction, InsertReaction };
