/**
 * Main orchestrator — Auroic Message Router Agent
 *
 * Boot sequence:
 *   1. Init DB (Drizzle + SQLite)
 *   2. Launch browser and init Instagram session
 *
 * Event-driven:
 *   - Listens for NEW_MESSAGE / EDIT events from the WebSocket parser
 *   - Dispatches each to the processing pipeline
 */

import getConfig, { initRuntimeConfig } from "@/runtime/index.js";
import { startServer } from "@/api/server.js";
import logger from "@/utils/logger.js";
import { initDB, closeDB } from "@/db/index.js";
import { closeConfigDB } from "@/db/configDb.js";
import {
  initInstagramSession,
  disconnectBrowser,
} from "@/automation/session.js";
import { navigateToChat } from "@/automation/navigation.js";
import { runWithAutomationLock } from "@/automation/executionLock.js";
import { sendText } from "@/automation/chat.js";
import { attachDataMidToDOM } from "@/automation/chat.js";
import { eventBus } from "@/events.js";
import type { AppEvent } from "@/events.js";
import { processMessage } from "@/router/pipeline.js";
import { initKokoro } from "./runtime/tts.js";
import { getAllConversations } from "@/db/queries/conversations.js";

interface ConversationTracker {
  sessionStartTime: number;
  processedThisSession: Set<string>;
}

const tracker: ConversationTracker = {
  sessionStartTime: 0,
  processedThisSession: new Set<string>(),
};

const MAX_TRACKED_SESSION_MIDS = 5000;

function trackProcessedMid(mid: string): void {
  if (tracker.processedThisSession.has(mid)) return;
  tracker.processedThisSession.add(mid);

  while (tracker.processedThisSession.size > MAX_TRACKED_SESSION_MIDS) {
    const oldest = tracker.processedThisSession.values().next().value;
    if (!oldest) break;
    tracker.processedThisSession.delete(oldest);
  }
}

// Shutdown

let shuttingDown = false;

const SHUTDOWN_SIGNOFF_TEXT = "Signing off...Meet you again";

async function broadcastShutdownSignoff(): Promise<void> {
  const conversations = getAllConversations();
  if (!conversations.length) return;

  logger.info("Broadcasting shutdown sign-off", {
    totalConversations: conversations.length,
  });

  let sentCount = 0;

  for (const conversation of conversations) {
    const chatId = conversation.conversationId;

    try {
      await runWithAutomationLock("shutdown-signoff", chatId, async () => {
        await initInstagramSession();
        await navigateToChat(chatId);
        const sent = await sendText(
          SHUTDOWN_SIGNOFF_TEXT,
          chatId,
          undefined,
          { appendBotTag: false },
        );

        if (!sent) {
          throw new Error("sendText returned false");
        }
      });

      sentCount += 1;
    } catch (err) {
      logger.warn("Failed to send shutdown sign-off", {
        chatId,
        error: (err as Error).message,
      });
    }
  }

  logger.info("Shutdown sign-off completed", {
    sentCount,
    totalConversations: conversations.length,
  });
}

function registerShutdown(): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down gracefully…`);
    await broadcastShutdownSignoff();
    await disconnectBrowser();
    closeDB();
    closeConfigDB();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Event handler

function onAppEvent(event: AppEvent): void {
  if (shuttingDown) return;

  if (event.type === "NEW_MESSAGE" || event.type === "EDIT") {
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
        logger.info("Skipping already processed message in this session", {
          chatId: event.chatId,
          mid: event.mid,
        });
        return;
      }

      trackProcessedMid(event.mid);

      attachDataMidToDOM(event.chatId, event.mid).catch((err) => {
        logger.warn("Failed to stamp data-mid on DOM message", {
          chatId: event.chatId,
          mid: event.mid,
          error: (err as Error).message,
        });
      });

      const config = getConfig();
      if (event.senderFbid === config.instagram.fbId) return;
    }

    processMessage(event.chatId, event.mid).catch((err) => {
      logger.error("Message processing failed", {
        chatId: event.chatId,
        mid: event.mid,
        error: (err as Error).message,
      });
    });
  }
}

// Boot

async function boot(): Promise<void> {
  logger.info("Starting Auroic…");

  tracker.sessionStartTime = Date.now();
  tracker.processedThisSession.clear();

  const config = getConfig();
  initDB(config.db.path);

  try {
    await initInstagramSession();
    await initKokoro()
  } catch (err) {
    logger.error("Failed to start browser or init Instagram session", {
      error: (err as Error).message,
    });
    process.exit(1);
  }

  // Subscribe to events
  eventBus.on("event", onAppEvent);

  logger.info("Boot complete — listening for WebSocket events");
}

// Entry

registerShutdown();
initRuntimeConfig();
startServer();

boot().catch((err) => {
  logger.error("Fatal error during boot", {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
