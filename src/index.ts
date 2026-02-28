/**
 * Main orchestrator — Auroic Instagram AI Assistant.
 */

import getConfig, { watchRuntime } from "./config/index.js";
import { startServer } from "./server.js";
import logger from "./utils/logger.js";
import { sleep } from "./utils/delay.js";
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
  getUnrepliedTriggerMessages,
} from "./instagram/chat.js";
import { getAIReply } from "./ai/client.js";
import { simulateTyping } from "./typing/simulator.js";
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
import type { Page } from "playwright";

// Shutdown

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

// Priority

function determinePriority(text: string, isReply: boolean): number {
  const config = getConfig();
  const lower = text.toLowerCase();

  if (config.triggers.mentions.some((m: string) => lower.includes(m)))
    return 10;
  if (config.triggers.hashtags.some((h: string) => lower.includes(h))) return 8;
  if (config.triggers.keywords.some((k: string) => lower.includes(k))) return 6;
  if (isReply) return 5;
  return 0;
}

// Shared reply dispatcher

interface ReplyJob {
  page: Page;
  chatId: string;
  sender: string;
  text: string;
  history: string[];
  fingerprint: string;
  isReply: boolean;
}

async function dispatchReply(job: ReplyJob): Promise<void> {
  const { page, chatId, sender, text, history, fingerprint, isReply } = job;

  if (isOnCooldown(sender)) {
    logger.info("⏳ User on cooldown — skipping", { chatId, user: sender });
    return;
  }

  const priority = determinePriority(text, isReply);

  logger.info("🔔 Trigger detected", {
    chatId,
    username: sender,
    text: text.substring(0, 80),
    priority,
  });

  const typing = simulateTyping(page);

  let reply: string;
  try {
    reply = await getAIReply({
      user: sender,
      message: text,
      history,
      conversationId: chatId,
      priority,
    });
  } catch (err) {
    logger.error("AI API failed — skipping", {
      chatId,
      error: (err as Error).message,
    });
    markProcessed(fingerprint, chatId);
    return;
  }

  await typing.stop();
  recordRequest(sender);
  await sendMessage(page, reply, text);
  markProcessed(fingerprint, chatId);

  logger.info("✅ Reply delivered", {
    chatId,
    username: sender,
    replyLength: reply.length,
  });
}

// Chat processors

async function processUnrepliedTriggers(
  page: Page,
  chatId: string,
): Promise<void> {
  const unreplied = await getUnrepliedTriggerMessages(
    page,
    getConfig().instagram.username,
  );

  const triggered = unreplied.filter((msg) => shouldTrigger(msg.text, false));
  if (!triggered.length) return;

  logger.info(`Found ${triggered.length} unreplied trigger message(s)`, {
    chatId,
  });

  for (const msg of triggered) {
    const fingerprint = messageFingerprint(
      chatId,
      msg.sender,
      msg.text,
      msg.index,
    );
    if (isProcessed(fingerprint)) continue;

    await dispatchReply({
      page,
      chatId,
      sender: msg.sender,
      text: msg.text,
      history: [msg.text],
      fingerprint,
      isReply: false,
    });
  }
}

async function processChat(page: Page, chatId: string): Promise<void> {
  await processUnrepliedTriggers(page, chatId);

  const config = getConfig();
  const lastData = await getLastMessageData(page, config.instagram.username);
  if (!lastData?.text) {
    logger.debug("No message text found in chat", { chatId });
    return;
  }

  const { text, count, history, lastSender } = lastData;

  logger.info("Latest message found", {
    chatId,
    username: lastSender,
    text,
    count,
  });

  const fingerprint = messageFingerprint(chatId, lastSender, text, count);

  if (isProcessed(fingerprint)) {
    logger.debug("Message already processed — skipping", { chatId });
    return;
  }

  if (lastSender === config.instagram.username) {
    logger.debug("Last message is from bot — skipping", { chatId });
    markProcessed(fingerprint, chatId);
    return;
  }

  const isReply = await isLastMessageReply(page);

  if (!shouldTrigger(text, isReply)) {
    logger.debug("No trigger matched — skipping", {
      chatId,
      text: text.substring(0, 50),
    });
    markProcessed(fingerprint, chatId);
    return;
  }

  await dispatchReply({
    page,
    chatId,
    sender: lastSender,
    text,
    history,
    fingerprint,
    isReply,
  });
}

// Main loop

async function mainLoop(): Promise<void> {
  logger.info("Starting Auroic Instagram AI Assistant…");

  const initialChatIds = getConfig().instagram.chatIds.filter(Boolean);
  if (!initialChatIds.length) {
    logger.warn("No CHAT_IDS configured initially.");
  } else {
    logger.info(`Monitoring ${initialChatIds.length} chat(s) initially`, {
      chatIds: initialChatIds,
    });
  }

  initDB();
  pruneOldRecords();

  try {
    await connectBrowser();
    if (initialChatIds.length > 0) {
      await openChatTabs(initialChatIds);
    }
  } catch (err) {
    logger.error("Failed to connect to Chrome or open tabs — exiting", {
      error: (err as Error).message,
    });
    process.exit(1);
  }

  logger.info(`Browser connected — starting poll loop`);

  let cycleCount = 0;

  while (!shuttingDown) {
    cycleCount++;
    logger.info(`Poll cycle #${cycleCount}`);

    try {
      const currentChatIds = getConfig().instagram.chatIds.filter(Boolean);
      await ensureChatTabs(currentChatIds);

      for (const chatId of currentChatIds) {
        if (shuttingDown) break;

        const page = getChatPage(chatId);
        if (!page || page.isClosed()) {
          logger.warn("Chat tab unavailable — will re-open next cycle", {
            chatId,
          });
          continue;
        }

        await processChat(page, chatId);
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
      logger.info("📊 Rate limiter metrics", getMetrics());
    }

    const pollMs = getConfig().poll.intervalMs;
    logger.debug(`Sleeping ${pollMs}ms before next poll…`);
    await sleep(pollMs);
  }
}

// Bootstrap

registerShutdown();
watchRuntime();
startServer();
mainLoop().catch((err) => {
  logger.error("Fatal error", {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
