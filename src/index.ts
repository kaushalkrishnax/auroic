/**
 * Main orchestrator — Auroic Instagram AI Assistant.
 */

import config from "./config/index.js";
import logger from "./utils/logger.js";
import { randomDelay, sleep } from "./utils/delay.js";
import {
  connectBrowser,
  openChatTabs,
  getChatPage,
  ensureChatTabs,
  disconnectBrowser,
} from "./browser/connection.js";
import {
  getLastMessageData,
  isLastMessageReply,
  shouldTrigger,
  messageFingerprint,
  sendMessage,
} from "./instagram/chat.js";
import { getAIReply } from "./ai/client.js";
import { startTypingSimulation } from "./typing/simulator.js";
import {
  isOnCooldown,
  recordRequest,
  pruneCooldowns,
} from "./ai/cooldownManager.js";
import { getMetrics } from "./ai/rateLimiter.js";
import {
  initDB,
  isProcessed,
  markProcessed,
  pruneOldRecords,
  closeDB,
} from "./state/db.js";
import type { Page } from "playwright-core";

// Shutdown handling

let shuttingDown = false;

function registerShutdown(): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down gracefully…`);
    await disconnectBrowser();
    closeDB();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Priority determination

function determinePriority(text: string, isReply: boolean): number {
  const lower = text.toLowerCase();

  for (const mention of config.triggers.mentions) {
    if (lower.includes(mention)) return 10;
  }

  for (const hashtag of config.triggers.hashtags) {
    if (lower.includes(hashtag)) return 8;
  }

  if (isReply) return 5;
  return 0;
}

// Process a single chat by its dedicated page

async function processChat(page: Page, chatId: string): Promise<void> {
  const lastData = await getLastMessageData(page, config.instagram.username);

  if (!lastData || !lastData.text) {
    logger.debug("No message text found in chat", { chatId });
    return;
  }

  const { text: lastText, count: messageCount, history, lastSender } = lastData;

  logger.info("Latest Message Found", {
    chatId,
    username: lastSender,
    text: lastText,
    count: messageCount,
  });

  const fingerprintId = messageFingerprint(
    chatId,
    lastSender,
    lastText,
    messageCount,
  );
  if (isProcessed(fingerprintId)) {
    logger.debug("Message already processed — skipping", { chatId });
    return;
  }

  if (lastSender === config.instagram.username) {
    logger.debug("Last message is from bot — skipping", { chatId });
    markProcessed(fingerprintId, chatId);
    return;
  }

  if (isOnCooldown(lastSender)) {
    logger.info("⏳ User on cooldown — skipping", { chatId, user: lastSender });
    return;
  }

  const isReply = await isLastMessageReply(page);

  if (!shouldTrigger(lastText, isReply)) {
    logger.debug("No trigger matched — skipping", {
      chatId,
      text: lastText.substring(0, 50),
    });
    markProcessed(fingerprintId, chatId);
    return;
  }

  const priority = determinePriority(lastText, isReply);

  logger.info("🔔 Trigger detected!", {
    chatId,
    username: lastSender,
    text: lastText.substring(0, 80),
    count: messageCount,
    priority,
  });

  const typing = startTypingSimulation(page);

  let reply: string;
  try {
    reply = await getAIReply({
      user: lastSender,
      message: lastText,
      history,
      conversationId: chatId,
      priority,
    });
  } catch (err) {
    logger.error("AI API failed after retries — skipping conversation", {
      chatId,
      error: (err as Error).message,
    });
    try {
      await typing.finishAfterResponse("");
    } catch {
      /* best-effort cleanup */
    }
    markProcessed(fingerprintId, chatId);
    return;
  }

  recordRequest(lastSender);
  await typing.finishAfterResponse(reply);

  await randomDelay(300, 700);
  await sendMessage(page, reply);

  markProcessed(fingerprintId, chatId);

  logger.info("✅ Reply delivered", {
    chatId,
    username: lastSender,
    replyLength: reply.length,
  });
}

// Main loop

async function mainLoop(): Promise<void> {
  logger.info("Starting Auroic Instagram AI Assistant…");

  const { chatIds } = config.instagram;
  if (!chatIds.length) {
    logger.error("No CHAT_IDS configured — set CHAT_IDS in your .env file");
    process.exit(1);
  }
  logger.info(`Monitoring ${chatIds.length} chat(s)`, { chatIds });

  initDB();
  pruneOldRecords();

  try {
    await connectBrowser();
    await openChatTabs(chatIds);
  } catch (err) {
    logger.error("Failed to connect to Chrome or open tabs — exiting", {
      error: (err as Error).message,
    });
    process.exit(1);
  }

  logger.info(`All ${chatIds.length} chat tab(s) ready — starting poll loop`);

  let cycleCount = 0;

  while (!shuttingDown) {
    cycleCount++;
    logger.info(`Poll cycle #${cycleCount}`);

    try {
      await ensureChatTabs(chatIds);

      for (const chatId of chatIds) {
        if (shuttingDown) break;

        const page = getChatPage(chatId);
        if (!page || page.isClosed()) {
          logger.warn("Chat tab unavailable — will re-open next cycle", {
            chatId,
          });
          continue;
        }

        await processChat(page, chatId);
        await randomDelay(500, 1_000);
      }
    } catch (err) {
      logger.error("Error during poll cycle", {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    }

    if (cycleCount % 50 === 0) {
      pruneOldRecords();
      pruneCooldowns();
    }

    if (cycleCount % 10 === 0) {
      const metrics = getMetrics();
      logger.info("📊 Rate limiter metrics", metrics);
    }

    logger.debug(`Sleeping ${config.poll.intervalMs}ms before next poll…`);
    await sleep(config.poll.intervalMs);
  }
}

// Bootstrap

registerShutdown();
mainLoop().catch((err) => {
  logger.error("Fatal error", {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
