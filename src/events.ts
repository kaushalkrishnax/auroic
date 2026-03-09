/**
 * Global event bus — used to stream real-time events to the SSE endpoint.
 *
 * Publishers (parsers, pipeline) call emitEvent().
 * The SSE handler in api/server.ts subscribes via eventBus.on("event", ...).
 */

import { EventEmitter } from "node:events";
import type { RouterDecision } from "@/types/index.js";

// Event shapes

export type AppEvent =
  | {
      type: "NEW_MESSAGE";
      chatId: string;
      mid: string;
      senderFbid: string;
      timestampMs: number;
    }
  | { type: "EDIT"; chatId: string; mid: string }
  | { type: "DELETE"; chatId: string; mid: string }
  | {
      type: "REACTION_ADD";
      chatId: string;
      mid: string;
      senderFbid: string;
      reaction: string;
    }
  | { type: "REACTION_REMOVE"; chatId: string; mid: string }
  | {
      type: "ROUTER_DECISION";
      chatId: string;
      decision: RouterDecision;
      resultText: string | null;
    }
  | {
      type: "OUTGOING";
      chatId: string;
      actionType: string;
      content: string | null;
    }
  | { type: "CONFIG_CHANGED" };

// Bus

class AppEventBus extends EventEmitter {
  override emit(event: "event", data: AppEvent): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  override on(event: "event", listener: (data: AppEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(
    event: string | symbol,
    listener: (...args: any[]) => void,
  ): this {
    return super.on(event, listener);
  }

  override off(event: "event", listener: (data: AppEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override off(
    event: string | symbol,
    listener: (...args: any[]) => void,
  ): this {
    return super.off(event, listener);
  }
}

export const eventBus = new AppEventBus();
eventBus.setMaxListeners(200);

export function emitEvent(event: AppEvent): void {
  eventBus.emit("event", event);
}
