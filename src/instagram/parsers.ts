/**
 * Instagram protocol parsers.
 *
 * Converts raw Instagram GraphQL / WebSocket payloads into DB inserts.
 * Also provides mailbox and thread seeders (initMailbox, initThread)
 * that bootstrap the database from GraphQL responses on first load.
 *
 * No business logic lives here — only protocol → DB translation.
 */

import { insertIncomingMessage } from "@/db/queries/messages.js";
import { getMediaForMessage, insertMedia } from "@/db/queries/media.js";
import { editMessage } from "@/db/queries/messages.js";
import { markMessageDeleted } from "@/db/queries/messages.js";
import { insertReaction } from "@/db/queries/reactions.js";
import { deleteReaction } from "@/db/queries/reactions.js";
import { createUsers } from "@/db/queries/users.js";
import {
  createConversation,
  createConversationParticipants,
  ensureConversationExists,
} from "@/db/queries/conversations.js";
import { setBotFbid, BOT_FBID } from "@/runtime/index.js";
import { emitEvent } from "@/events.js";
import logger from "@/utils/logger.js";
import type { RawIGMessage, RawIGThread } from "@/types/index.js";

// Media parsing

function pickString(
  obj: Record<string, unknown> | undefined,
  keys: string[],
): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function pickNumber(
  obj: Record<string, unknown> | undefined,
  keys: string[],
): number | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

function parseMedia(msg: RawIGMessage): void {
  const content = msg.content as Record<string, unknown> | undefined;
  if (!content) return;

  const type = content.__typename as string | undefined;
  const messageType = String(msg.content_type ?? "").toUpperCase();

  const parseMusicStickerXma = () => {
    const xma = content.xma as Record<string, unknown> | undefined;
    const music = content.music as Record<string, unknown> | undefined;
    const previewImage =
      (xma?.preview_image as Record<string, unknown> | undefined) ??
      (music?.preview_image as Record<string, unknown> | undefined);

    const previewUrl =
      (previewImage?.url as string | null) ??
      (content.preview_url as string | null) ??
      (content.cover_art_url as string | null) ??
      (content.thumbnail_url as string | null) ??
      (xma?.preview_url as string | null) ??
      (music?.cover_art_url as string | null) ??
      null;

    const targetUrl =
      (xma?.target_url as string | null) ??
      (content.target_url as string | null) ??
      (content.url as string | null) ??
      null;

    const width =
      (previewImage?.width as number | null) ??
      (content.preview_width as number | null) ??
      (content.width as number | null) ??
      null;

    const height =
      (previewImage?.height as number | null) ??
      (content.preview_height as number | null) ??
      (content.height as number | null) ??
      null;

    insertMedia({
      messageId: msg.id,
      attachmentType: "MUSIC_STICKER_XMA",
      url: targetUrl,
      previewUrl,
      width,
      height,
    });
  };

  switch (type) {
    case "SlideMessageImageContent": {
      const attachments =
        (content.attachments as Record<string, unknown>[]) ?? [];
      for (const a of attachments) {
        insertMedia({
          messageId: msg.id,
          attachmentType: "IMAGE",
          url: a.attachment_cdn_url as string | null,
          previewUrl: a.preview_cdn_url as string | null,
          width: a.preview_width as number | null,
          height: a.preview_height as number | null,
        });
      }
      break;
    }

    case "SlideMessageVideosContent": {
      const videos = (content.videos as Record<string, unknown>[]) ?? [];
      for (const v of videos) {
        insertMedia({
          messageId: msg.id,
          attachmentType: "VIDEO",
          url: v.attachment_cdn_url as string | null,
          previewUrl: v.preview_cdn_url as string | null,
          width: v.preview_width as number | null,
          height: v.preview_height as number | null,
        });
      }
      break;
    }

    case "SlideMessageAudiosContent": {
      const audios =
        (content.audio_attachments as Record<string, unknown>[]) ?? [];
      for (const a of audios) {
        insertMedia({
          messageId: msg.id,
          attachmentType: "AUDIO",
          url: a.attachment_cdn_url as string | null,
          durationMs: a.playable_duration_ms as number | null,
        });
      }
      break;
    }

    case "SlideMessageAnimatedMediaContent": {
      const gifs = (content.animated_media as Record<string, unknown>[]) ?? [];
      for (const g of gifs) {
        const url =
          pickString(g, [
            "attachment_mp4_url",
            "attachment_cdn_url",
            "attachment_url",
            "media_url",
            "url",
          ]) ?? null;
        const previewUrl =
          pickString(g, [
            "preview_cdn_url",
            "preview_url",
            "image_url",
            "thumbnail_url",
            "url",
          ]) ?? null;

        insertMedia({
          messageId: msg.id,
          attachmentType: (g.is_sticker as boolean) ? "STICKER_GIF" : "GIF",
          url,
          previewUrl,
          width: pickNumber(g, ["preview_width", "width"]),
          height: pickNumber(g, ["preview_height", "height"]),
        });
      }
      break;
    }

    case "SlideMessageCutoutStickerXMAContent":
      insertMedia({
        messageId: msg.id,
        attachmentType: "CUTOUT_STICKER",
        url: content.preview_url as string | null,
        previewUrl: content.preview_url as string | null,
      });
      break;

    case "SlideMessageAvatarStickerXMAContent":
      insertMedia({
        messageId: msg.id,
        attachmentType: "AVATAR_STICKER",
        url: content.preview_url as string | null,
        previewUrl: content.preview_url as string | null,
      });
      break;

    case "SlideMessageXMAContent": {
      const xma = content.xma as Record<string, unknown> | undefined;
      const targetUrl =
        pickString(xma, ["target_url", "fallback_url", "url"]) ??
        pickString(content, ["target_url", "fallback_url", "url"]) ??
        null;

      insertMedia({
        messageId: msg.id,
        attachmentType: "XMA_SHARE",
        url: targetUrl,
        previewUrl: null,
        width: null,
        height: null,
      });
      break;
    }

    case "SlideMessageMusicStickerXMAContent":
      parseMusicStickerXma();
      break;

    default:
      if (messageType === "MUSIC_STICKER_XMA") {
        parseMusicStickerXma();
      } else if (messageType === "MESSAGE_INLINE_SHARE") {
        // Inline shares often arrive with MESSAGE_INLINE_SHARE content_type.
        const xma = content.xma as Record<string, unknown> | undefined;

        insertMedia({
          messageId: msg.id,
          attachmentType: "XMA_SHARE",
          url:
            pickString(xma, ["target_url", "fallback_url", "url"]) ??
            pickString(content, ["target_url", "fallback_url", "url"]) ??
            null,
          previewUrl: null,
          width: null,
          height: null,
        });
      } else if (messageType === "INSTAGRAM_MESSAGING_ANIMATED_IMAGE") {
        const animated =
          (content.animated_media as Record<string, unknown>[]) ?? [];
        for (const media of animated) {
          insertMedia({
            messageId: msg.id,
            attachmentType: (media.is_sticker as boolean)
              ? "STICKER_GIF"
              : "GIF",
            url:
              pickString(media, [
                "attachment_mp4_url",
                "attachment_cdn_url",
                "attachment_url",
                "media_url",
                "url",
              ]) ?? null,
            previewUrl:
              pickString(media, [
                "preview_cdn_url",
                "preview_url",
                "image_url",
                "thumbnail_url",
                "url",
              ]) ?? null,
            width: pickNumber(media, ["preview_width", "width"]),
            height: pickNumber(media, ["preview_height", "height"]),
          });
        }
      }
      break;
  }
}

function parseEmbeddedRepliedMessage(message: RawIGMessage): void {
  const parent = message as unknown as { replied_to_message?: unknown };
  const rawReply = parent.replied_to_message;
  if (!rawReply || typeof rawReply !== "object") return;

  const reply = rawReply as Record<string, unknown>;
  const replyId = String(reply.id ?? reply.message_id ?? "").trim();
  if (!replyId || replyId === message.id) return;

  const senderFbid = String(reply.sender_fbid ?? "").trim();
  if (!senderFbid) return;

  const embeddedReply: RawIGMessage = {
    id: replyId,
    thread_fbid: String(reply.thread_fbid ?? message.thread_fbid),
    sender_fbid: senderFbid,
    timestamp_ms: Number(reply.timestamp_ms ?? message.timestamp_ms),
    content_type:
      typeof reply.content_type === "string" ? reply.content_type : undefined,
    text_body: typeof reply.text_body === "string" ? reply.text_body : "",
    replied_to_message_id:
      typeof reply.replied_to_message_id === "string"
        ? reply.replied_to_message_id
        : null,
    content:
      (reply.content as Record<string, unknown> | undefined) ?? undefined,
  };

  parseMessage(embeddedReply, false);
}

// Single message

export function parseMessage(msg: RawIGMessage, parseNestedReply = true): void {
  if (parseNestedReply) {
    parseEmbeddedRepliedMessage(msg);
  }

  // Ensure the conversation row exists (WebSocket messages can arrive before GraphQL seeding)
  ensureConversationExists(msg.thread_fbid);

  const inserted = insertIncomingMessage({
    messageId: msg.id,
    conversationId: msg.thread_fbid,
    userId: msg.sender_fbid,
    timestampMs: Number(msg.timestamp_ms),
    messageType: msg.content_type ?? null,
    textContent: msg.text_body ?? null,
    replyToMessageId: msg.replied_to_message_id ?? null,
  });

  if (inserted === null) {
    // Backfill media on existing messages when thread re-seeding receives richer payloads.
    const existingMedia = getMediaForMessage(msg.id);
    if (!existingMedia.length) {
      parseMedia(msg);
    }
    return;
  }

  parseMedia(msg);
}

// Thread message bulk-insert

export function parseThreadMessages(thread: RawIGThread): void {
  const edges = thread.slide_messages?.edges ?? [];
  for (const edge of edges) {
    if (edge.node) parseMessage(edge.node);
  }
}

// Mailbox seeder

export function initMailbox(mailbox: unknown): void {
  type MailboxShape = {
    data?: {
      get_slide_mailbox_for_iris_subscription?: {
        threads_by_folder?: { edges?: unknown[] };
      };
    };
  };

  const data = mailbox as MailboxShape;
  const edges: unknown[] =
    data?.data?.get_slide_mailbox_for_iris_subscription?.threads_by_folder
      ?.edges ?? [];

  for (const edge of edges) {
    const e = edge as Record<string, unknown>;
    const node = e.node as Record<string, unknown> | undefined;
    const thread = node?.as_ig_direct_thread as RawIGThread | undefined;
    if (!thread) continue;

    const users = thread.users ?? [];
    const viewer = thread.viewer;

    if (viewer?.interop_messaging_user_fbid) {
      setBotFbid(viewer.interop_messaging_user_fbid);
    }

    createUsers(users);
    createConversation(thread);
    createConversationParticipants(thread.thread_fbid, users);
  }

  logger.info("Mailbox metadata initialised", { chatCount: edges.length });
}

// Thread seeder

export function initThread(threadData: unknown): string | null {
  type ThreadShape = {
    data?: {
      get_slide_thread_nullable?: {
        as_ig_direct_thread?: RawIGThread;
      };
    };
  };

  const data = threadData as ThreadShape;
  const thread = data?.data?.get_slide_thread_nullable?.as_ig_direct_thread;

  if (!thread) return null;

  const users = thread.users ?? [];
  const messages = thread.slide_messages?.edges ?? [];

  createUsers(users);
  createConversation(thread);
  createConversationParticipants(thread.thread_fbid, users);

  for (const edge of messages) {
    if (edge.node) parseMessage(edge.node);
  }

  return thread.thread_fbid;
}

// WebSocket frame

interface ParsedEvent {
  type: string;
  chatId: string;
  mid: string;
  contentType?: string;
  senderFbid?: string;
  timestampMs?: number;
  is_self?: boolean;
}

function extractJSON(payload: string) {
  const start = payload.indexOf('[{"data"');
  if (start === -1) return null;

  const end = payload.lastIndexOf('}]');
  if (end === -1) return null;

  try {
    return JSON.parse(
      payload.slice(start, end + 2)
    );
  } catch {
    return null;
  }
}

export function parseWebsocketFrame(
  payload: string,
  allowedChatIds?: string[],
): ParsedEvent[] | null {
  const json = extractJSON(payload);
  if (!json) return null;

  const events =
    (((json[0] as Record<string, unknown>)?.data as Record<string, unknown>)
      ?.slide_delta_processor as Record<string, unknown>[] | undefined) ?? [];

  const results: ParsedEvent[] = [];

  for (const event of events) {
    switch (event.__typename) {
      case "SlideUQPPNewMessage": {
        const msg = event.message as RawIGMessage;

        if (allowedChatIds?.length && !allowedChatIds.includes(msg.thread_fbid))
          continue;

        parseMessage(msg);
        const ev: ParsedEvent = {
          type: "NEW_MESSAGE",
          chatId: msg.thread_fbid,
          mid: msg.id,
          contentType: msg.content_type,
          senderFbid: msg.sender_fbid,
          timestampMs: Number(msg.timestamp_ms),
          is_self: BOT_FBID !== null && msg.sender_fbid === BOT_FBID,
        };
        emitEvent({
          type: "NEW_MESSAGE",
          chatId: ev.chatId,
          mid: ev.mid,
          senderFbid: ev.senderFbid!,
          timestampMs: ev.timestampMs!,
        });
        results.push(ev);
        break;
      }

      case "SlideUQPPEditMessage": {
        editMessage(event.message_id as string, event.text_body as string);
        const ev: ParsedEvent = {
          type: "EDIT",
          chatId: event.thread_fbid as string,
          mid: event.message_id as string,
        };
        emitEvent({ type: "EDIT", chatId: ev.chatId, mid: ev.mid });
        results.push(ev);
        break;
      }

      case "SlideUQPPDeleteMessage": {
        markMessageDeleted(event.message_id as string);
        const ev: ParsedEvent = {
          type: "DELETE",
          chatId: event.thread_fbid as string,
          mid: event.message_id as string,
        };
        emitEvent({ type: "DELETE", chatId: ev.chatId, mid: ev.mid });
        results.push(ev);
        break;
      }

      case "SlideUQPPCreateReaction": {
        const rxn = event.reaction as Record<string, unknown>;
        insertReaction({
          messageId: event.message_id as string,
          userId: rxn.sender_fbid as string,
          reaction: rxn.reaction as string,
          timestampMs: Number(rxn.reaction_timestamp_ms),
        });
        const ev: ParsedEvent = {
          type: "REACTION_ADD",
          chatId: event.thread_fbid as string,
          mid: event.message_id as string,
        };
        emitEvent({
          type: "REACTION_ADD",
          chatId: ev.chatId,
          mid: ev.mid,
          senderFbid: rxn.sender_fbid as string,
          reaction: rxn.reaction as string,
        });
        results.push(ev);
        break;
      }

      case "SlideUQPPDeleteReaction": {
        deleteReaction(event.message_id as string);
        const ev: ParsedEvent = {
          type: "REACTION_REMOVE",
          chatId: event.thread_fbid as string,
          mid: event.message_id as string,
        };
        emitEvent({ type: "REACTION_REMOVE", chatId: ev.chatId, mid: ev.mid });
        results.push(ev);
        break;
      }
    }
  }

  return results.length ? results : null;
}
