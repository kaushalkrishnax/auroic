/**
 * Shared domain types.
 * DB row types are imported directly from @/db/schema.
 */

export type ActionType = "text" | "ignore" | "react" | "media";
export type EffortLevel = "low" | "medium" | "high";

export interface RouterDecision {
  type: ActionType;
  /** C1–C3 candidate slot or null */
  target: string | null;
  effort: EffortLevel | null;
  title: string | null;
  reason: string | null;
}

export interface ClassifiedCommand {
  commandName: string;
  actionType: ActionType;
  query: string;
  similarity: number;
}

/** Matches the Drizzle SelectMessage row shape used in the router pipeline. */
export interface Message {
  id: number;
  messageId: string;
  conversationId: string;
  userId: string;
  timestampMs: number;
  messageType: string | null;
  textContent: string | null;
  replyToMessageId: string | null;
  isEdited: boolean | null;
  isDeleted: boolean | null;
  rawPayload: string | null;
  createdAt: string | null;
}

export interface ActionContext {
  chatId: string;
  message: Message;
  /** H1–H5 history + C1–C3 candidates sent to the router */
  history: string[];
  candidates: string[];
  decision: RouterDecision;
  targetMessageId: string | null;
  targetTextContent: string | null;
  /** Classified command if matched by command classifier */
  classifiedCommand?: ClassifiedCommand;
  core?: any;
}

export interface PlatformUser {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isVerified?: boolean;
  platform: string;
}

export interface PlatformConversation {
  conversationId: string;
  platform: string;
  title: string | null;
  avatarUrl?: string | null;
  createdByUserId?: string | null;
  isGroup: boolean;
  isMuted?: boolean;
}
