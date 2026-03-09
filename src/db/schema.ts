/**
 * Drizzle ORM schema — mirrors the SQLite tables exactly.
 * All table definitions and their inferred types live here.
 */

import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";
import { sql, InferSelectModel, InferInsertModel } from "drizzle-orm";

// users

export const users = sqliteTable("users", {
  senderFbid: text("sender_fbid").primaryKey(),
  username: text("username"),
  fullName: text("full_name"),
  profilePicUrl: text("profile_pic_url"),
  isVerified: integer("is_verified", { mode: "boolean" }).default(false),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// chats

export const chats = sqliteTable("chats", {
  chatId: text("chat_id").primaryKey(),
  title: text("title"),
  imageUrl: text("image_url"),
  groupCreatorId: text("group_creator_id"),
  isGroup: integer("is_group", { mode: "boolean" }).default(false),
  isMuted: integer("is_muted", { mode: "boolean" }).default(false),
  lastProcessedMid: text("last_processed_mid"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// chat_participants

export const chatParticipants = sqliteTable(
  "chat_participants",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.chatId),
    senderFbid: text("sender_fbid")
      .notNull()
      .references(() => users.senderFbid),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.senderFbid] })],
);

// messages

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mid: text("mid").unique().notNull(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.chatId),
    senderFbid: text("sender_fbid").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    contentType: text("content_type"),
    textBody: text("text_body"),
    repliedToMid: text("replied_to_mid"),
    edited: integer("edited", { mode: "boolean" }).default(false),
    deleted: integer("deleted", { mode: "boolean" }).default(false),
    processedAt: text("processed_at"),
    processingLockAt: text("processing_lock_at"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_messages_chat_time").on(table.chatId, table.timestampMs),
    index("idx_messages_sender").on(table.senderFbid),
  ],
);

// media

export const media = sqliteTable(
  "media",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageMid: text("message_mid")
      .notNull()
      .references(() => messages.mid),
    mediaType: text("media_type"),
    url: text("url"),
    previewUrl: text("preview_url"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_media_message").on(table.messageMid)],
);

// reactions

export const reactions = sqliteTable("reactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  messageMid: text("message_mid")
    .notNull()
    .references(() => messages.mid),
  senderFbid: text("sender_fbid").notNull(),
  reaction: text("reaction").notNull(),
  timestampMs: integer("timestamp_ms"),
});

// outgoing_messages

export const outgoingMessages = sqliteTable("outgoing_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: text("chat_id").notNull(),
  targetMessageMid: text("target_message_mid"),
  type: text("type").notNull(),
  effort: text("effort"),
  title: text("title"),
  content: text("content"),
  reason: text("reason"),
  platformMid: text("platform_mid"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// Inferred types

export type SelectUser = InferSelectModel<typeof users>;
export type InsertUser = InferInsertModel<typeof users>;

export type SelectChat = InferSelectModel<typeof chats>;
export type InsertChat = InferInsertModel<typeof chats>;

export type SelectMessage = InferSelectModel<typeof messages>;
export type InsertMessage = InferInsertModel<typeof messages>;

export type SelectMedia = InferSelectModel<typeof media>;
export type InsertMedia = InferInsertModel<typeof media>;

export type SelectReaction = InferSelectModel<typeof reactions>;
export type InsertReaction = InferInsertModel<typeof reactions>;

export type SelectOutgoing = InferSelectModel<typeof outgoingMessages>;
export type InsertOutgoing = InferInsertModel<typeof outgoingMessages>;

export type SelectChatParticipant = InferSelectModel<typeof chatParticipants>;
