/**
 * Message batcher.
 * Combines multiple messages from the same conversation within BATCH_WINDOW_MS.
 */

import getConfig from "../config/index.js";
import logger from "../utils/logger.js";

interface BatchEntry {
  messages: string[];
  timer: ReturnType<typeof setTimeout>;
  resolve: (combined: string) => void;
}

const batches = new Map<string, BatchEntry>();

export function addMessage(
  conversationId: string,
  message: string,
): Promise<string> {
  const existing = batches.get(conversationId);

  if (existing) {
    existing.messages.push(message);
    logger.debug("Message batched", {
      conversationId,
      batchSize: existing.messages.length,
    });

    return new Promise((resolve) => {
      const prev = existing.resolve;
      existing.resolve = (combined: string) => {
        prev(combined);
        resolve(combined);
      };
    });
  }

  return new Promise((resolve) => {
    const entry: BatchEntry = {
      messages: [message],
      timer: setTimeout(() => {
        flush(conversationId);
      }, getConfig().batching.windowMs),
      resolve,
    };

    batches.set(conversationId, entry);
    logger.debug("Batch started", {
      conversationId,
      windowMs: getConfig().batching.windowMs,
    });
  });
}

export function flush(conversationId: string): string | null {
  const entry = batches.get(conversationId);
  if (!entry) return null;

  clearTimeout(entry.timer);
  batches.delete(conversationId);

  const combined = entry.messages.join("\n");
  logger.debug("Batch flushed", {
    conversationId,
    messageCount: entry.messages.length,
    combinedLength: combined.length,
  });
  entry.resolve(combined);
  return combined;
}

export function hasPendingBatch(conversationId: string): boolean {
  return batches.has(conversationId);
}
