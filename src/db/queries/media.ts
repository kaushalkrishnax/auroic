import { eq, desc } from "drizzle-orm";
import { getDB } from "@/db/index.js";
import { media } from "@/db/schema.js";
import type { SelectMedia, InsertMedia } from "@/db/schema.js";

export interface MediaInput {
  messageMid: string;
  mediaType?: string | null;
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
      messageMid: input.messageMid,
      mediaType: input.mediaType ?? null,
      url: input.url ?? null,
      previewUrl: input.previewUrl ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      durationMs: input.durationMs ?? null,
    })
    .run();
}

export function getMediaForMessage(messageMid: string): SelectMedia[] {
  return getDB()
    .select()
    .from(media)
    .where(eq(media.messageMid, messageMid))
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
