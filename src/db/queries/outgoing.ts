import { desc } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { outgoingMessages } from "@/db/schema.js";
import type { SelectOutgoing, InsertOutgoing } from "@/db/schema.js";

export interface OutgoingInput {
  chatId: string;
  targetMessageMid?: string | null;
  type: string;
  effort?: string | null;
  title?: string | null;
  content?: string | null;
  reason?: string | null;
  platformMid?: string | null;
}

export function insertOutgoingMessage(input: OutgoingInput): number {
  const result = getDB()
    .insert(outgoingMessages)
    .values({
      chatId: input.chatId,
      targetMessageMid: input.targetMessageMid ?? null,
      type: input.type,
      effort: input.effort ?? null,
      title: input.title ?? null,
      content: input.content ?? null,
      reason: input.reason ?? null,
      platformMid: input.platformMid ?? null,
    })
    .returning({ id: outgoingMessages.id })
    .get();

  return result?.id ?? 0;
}

export function getAllOutgoing(limit = 200): SelectOutgoing[] {
  return getDB()
    .select()
    .from(outgoingMessages)
    .orderBy(desc(outgoingMessages.id))
    .limit(limit)
    .all();
}

export type { SelectOutgoing, InsertOutgoing };
