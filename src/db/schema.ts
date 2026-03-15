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
  userId: text("user_id").primaryKey(),
  platformUserId: text("platform_user_id"),
  username: text("username"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  isVerified: integer("is_verified", { mode: "boolean" }).default(false),
  platform: text("platform"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// conversations

export const conversations = sqliteTable("conversations", {
  conversationId: text("conversation_id").primaryKey(),
  platform: text("platform").notNull(),
  title: text("title"),
  avatarUrl: text("avatar_url"),
  createdByUserId: text("created_by_user_id"),
  isGroup: integer("is_group", { mode: "boolean" }).default(false),
  isMuted: integer("is_muted", { mode: "boolean" }).default(false),
  lastProcessedMessageId: text("last_processed_message_id"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// conversation_participants

export const conversationParticipants = sqliteTable(
  "conversation_participants",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.conversationId),
    userId: text("user_id")
      .notNull()
      .references(() => users.userId),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.userId] })],
);

// messages

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: text("message_id").unique().notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.conversationId),
    userId: text("user_id").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    messageType: text("message_type"), // text | media | system
    textContent: text("text_content"),
    replyToMessageId: text("reply_to_message_id"),
    isEdited: integer("is_edited", { mode: "boolean" }).default(false),
    isDeleted: integer("is_deleted", { mode: "boolean" }).default(false),
    rawPayload: text("raw_payload"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_messages_conversation_time").on(
      table.conversationId,
      table.timestampMs,
    ),
    index("idx_messages_user").on(table.userId),
    index("idx_messages_reply").on(table.replyToMessageId),
  ],
);

// media

export const media = sqliteTable(
  "media",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.messageId),
    attachmentType: text("attachment_type"),
    url: text("url"),
    previewUrl: text("preview_url"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_media_message").on(table.messageId)],
);

// message_reactions

export const messageReactions = sqliteTable("message_reactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  messageId: text("message_id")
    .notNull()
    .references(() => messages.messageId),
  userId: text("user_id").notNull(),
  reaction: text("reaction").notNull(),
  timestampMs: integer("timestamp_ms"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// message_features

export const messageFeatures = sqliteTable(
  "message_features",
  {
    messageId: text("message_id")
      .primaryKey()
      .references(() => messages.messageId),
    isQuestion: integer("is_question", { mode: "boolean" }).default(false),
    sentimentScore: integer("sentiment_score"),
    emotion: text("emotion"),
    length: integer("length"),
    emojiCount: integer("emoji_count"),
    mentionCount: integer("mention_count"),
    hasUrl: integer("has_url", { mode: "boolean" }),
    language: text("language"),
    topicHint: text("topic_hint"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_features_question").on(table.isQuestion)],
);

// outgoing

export const outgoing = sqliteTable(
  "outgoing",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    routerDecisionId: integer("router_decision_id"),
    conversationId: text("conversation_id").notNull(),
    targetMessageId: text("target_message_id"),
    targetUserId: text("target_user_id"),
    actionType: text("action_type").notNull(), // text | react | media | ignore
    effortLevel: text("effort_level"),
    intentLabel: text("intent_label"),
    messageContent: text("message_content"),
    executionStatus: text("execution_status"), // pending | sent | failed
    platformMessageId: text("platform_message_id"),
    executionError: text("execution_error"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_outgoing_conv").on(table.conversationId)],
);

// Inferred types

export type SelectUser = InferSelectModel<typeof users>;
export type InsertUser = InferInsertModel<typeof users>;

export type SelectConversation = InferSelectModel<typeof conversations>;
export type InsertConversation = InferInsertModel<typeof conversations>;

export type SelectMessage = InferSelectModel<typeof messages>;
export type InsertMessage = InferInsertModel<typeof messages>;

export type SelectMedia = InferSelectModel<typeof media>;
export type InsertMedia = InferInsertModel<typeof media>;

export type SelectMessageReaction = InferSelectModel<typeof messageReactions>;
export type InsertMessageReaction = InferInsertModel<typeof messageReactions>;

export type SelectOutgoing = InferSelectModel<typeof outgoing>;
export type InsertOutgoing = InferInsertModel<typeof outgoing>;

export type SelectMessageFeatures = InferSelectModel<typeof messageFeatures>;
export type InsertMessageFeatures = InferInsertModel<typeof messageFeatures>;

export type SelectConversationParticipant = InferSelectModel<
  typeof conversationParticipants
>;
