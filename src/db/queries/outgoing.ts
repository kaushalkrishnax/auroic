import { desc } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { outgoing } from "@/db/schema.js";
import type { SelectOutgoing, InsertOutgoing } from "@/db/schema.js";

export interface OutgoingInput {
  conversationId: string;
  targetMessageId?: string | null;
  actionType: string;
  effortLevel?: string | null;
  intentLabel?: string | null;
  messageContent?: string | null;
  executionStatus?: string | null;
  platformMessageId?: string | null;
  executionError?: string | null;
}

export function insertOutgoing(input: OutgoingInput): number {
  const result = getDB()
    .insert(outgoing)
    .values({
      conversationId: input.conversationId,
      targetMessageId: input.targetMessageId ?? null,
      actionType: input.actionType,
      effortLevel: input.effortLevel ?? null,
      intentLabel: input.intentLabel ?? null,
      messageContent: input.messageContent ?? null,
      executionStatus: input.executionStatus ?? "sent",
      platformMessageId: input.platformMessageId ?? null,
      executionError: input.executionError ?? null,
    })
    .returning({ id: outgoing.id })
    .get();

  return result?.id ?? 0;
}

export function getAllOutgoing(limit = 200): SelectOutgoing[] {
  return getDB()
    .select()
    .from(outgoing)
    .orderBy(desc(outgoing.id))
    .limit(limit)
    .all();
}

export type { SelectOutgoing, InsertOutgoing };
