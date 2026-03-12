import { eq, desc } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { media } from "@/db/schema.js";
import type { SelectMedia, InsertMedia } from "@/db/schema.js";

export interface MediaInput {
  messageId: string;
  attachmentType?: string | null;
  url?: string | null;
  previewUrl?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

export function insertMedia(input: MediaInput): void {
  getDB()
    .insert(media)
    .values({
      messageId: input.messageId,
      attachmentType: input.attachmentType ?? null,
      url: input.url ?? null,
      previewUrl: input.previewUrl ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      durationMs: input.durationMs ?? null,
    })
    .run();
}

export function getMediaForMessage(messageId: string): SelectMedia[] {
  return getDB()
    .select()
    .from(media)
    .where(eq(media.messageId, messageId))
    .all();
}

export function getAllMedia(limit = 100): SelectMedia[] {
  return getDB()
    .select()
    .from(media)
    .orderBy(desc(media.id))
    .limit(limit)
    .all();
}

export type { SelectMedia, InsertMedia };
