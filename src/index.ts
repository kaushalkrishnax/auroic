import getConfig, { initRuntimeConfig } from "@/runtime/index.js";
import { startServer } from "@/api/server.js";
import logger from "@/utils/logger.js";
import { initDB, closeDB } from "@/db/index.js";
import { closeConfigDB } from "@/db/configDb.js";
import {
  initInstagramSession,
  disconnectBrowser,
} from "@/automation/session.js";
import { attachDataMidToDOM } from "@/automation/chat.js";
import { eventBus } from "@/events.js";
import type { AppEvent } from "@/events.js";
import { processMessage } from "@/router/pipeline.js";

interface ConversationTracker {
  sessionStartTime: number;
  processedThisSession: Set<string>;
}

const tracker: ConversationTracker = {
  sessionStartTime: 0,
  processedThisSession: new Set<string>(),
};

const MAX_TRACKED_SESSION_MIDS = 5_000;

function trackProcessedMid(mid: string): void {
  if (tracker.processedThisSession.has(mid)) return;
  tracker.processedThisSession.add(mid);

  while (tracker.processedThisSession.size > MAX_TRACKED_SESSION_MIDS) {
    const oldest = tracker.processedThisSession.values().next().value;
    if (!oldest) break;
    tracker.processedThisSession.delete(oldest);
  }
}

let shuttingDown = false;

function registerShutdown(): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down gracefully…`);
    await disconnectBrowser();
    closeDB();
    closeConfigDB();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function onAppEvent(event: AppEvent): void {
  if (shuttingDown) return;
  if (event.type !== "NEW_MESSAGE" && event.type !== "EDIT") return;

  if (event.type === "NEW_MESSAGE") {
    if (event.timestampMs < tracker.sessionStartTime) {
      logger.info("Skipping offline message from before session start", {
        chatId: event.chatId,
        mid: event.mid,
        timestampMs: event.timestampMs,
        sessionStartTime: tracker.sessionStartTime,
      });
      return;
    }

    if (tracker.processedThisSession.has(event.mid)) {
      logger.info("Skipping already-processed message in this session", {
        chatId: event.chatId,
        mid: event.mid,
      });
      return;
    }

    trackProcessedMid(event.mid);

    attachDataMidToDOM(event.chatId, event.mid).catch((err: unknown) => {
      logger.warn("Failed to stamp data-mid on DOM message", {
        chatId: event.chatId,
        mid: event.mid,
        error: (err as Error).message,
      });
    });

    const config = getConfig();
    if (event.senderFbid === config.instagram.fbId) return;
  }

  processMessage(event.chatId, event.mid).catch((err: unknown) => {
    logger.error("Message processing failed", {
      chatId: event.chatId,
      mid: event.mid,
      error: (err as Error).message,
    });
  });
}

async function boot(): Promise<void> {
  logger.info("Starting Auroic…");

  tracker.sessionStartTime = Date.now();
  tracker.processedThisSession.clear();

  const config = getConfig();
  initDB(config.db.path);

  try {
    await initInstagramSession();
  } catch (err) {
    logger.error("Failed to init Instagram session", {
      error: (err as Error).message,
    });
    process.exit(1);
  }

  eventBus.on("event", onAppEvent);
  logger.info("Boot complete — listening for WebSocket events");
}

registerShutdown();
initRuntimeConfig();
startServer();

boot().catch((err: unknown) => {
  logger.error("Fatal error during boot", {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
