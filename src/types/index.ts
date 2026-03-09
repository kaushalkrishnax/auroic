/**
 * Shared domain types.
 * DB row types are imported directly from @/db/schema.
 */

export type ActionType =
  | "text"
  | "ignore"
  | "acknowledge"
  | "react"
  | "media"
  | "translate"
  | "command";
export type EffortLevel = "low" | "medium" | "high";

export interface RouterDecision {
  type: ActionType;
  /** M1–M5 slot or null */
  target: string | null;
  effort: EffortLevel | null;
  title: string | null;
  reason: string | null;
}

/** Matches the Drizzle SelectMessage row shape used in the router pipeline. */
export interface Message {
  id: number;
  mid: string;
  chatId: string;
  senderFbid: string;
  timestampMs: number;
  contentType: string | null;
  textBody: string | null;
  repliedToMid: string | null;
  edited: boolean | null;
  deleted: boolean | null;
  createdAt: string | null;
}

export interface ActionContext {
  chatId: string;
  message: Message;
  /** 5-element window (oldest → newest), padded with "<EMPTY>" */
  window: string[];
  decision: RouterDecision;
  targetMid: string | null;
  targetTextBody: string | null;
}

/** Raw Instagram user shape from GraphQL responses */
export interface RawIGUser {
  interop_messaging_user_fbid: string;
  username?: string;
  full_name?: string;
  profile_pic_url?: string | null;
  is_verified?: boolean;
}

/** Raw Instagram thread from GraphQL responses */
export interface RawIGThread {
  thread_fbid: string;
  thread_title?: string;
  thread_image_url?: string | null;
  group_creator: { interop_messaging_user_fbid?: string };
  is_group?: boolean;
  is_muted?: boolean;
  users?: RawIGUser[];
  viewer?: { interop_messaging_user_fbid?: string };
  slide_messages?: { edges: Array<{ node: RawIGMessage }> };
}

/** Raw Instagram message shape from GraphQL responses */
export interface RawIGMessage {
  id: string;
  thread_fbid: string;
  sender_fbid: string;
  timestamp_ms: string | number;
  content_type?: string;
  text_body?: string;
  replied_to_message_id?: string | null;
  content?: Record<string, unknown>;
}
