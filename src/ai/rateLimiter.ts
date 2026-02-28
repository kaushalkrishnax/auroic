/**
 * Central request queue with sliding-window rate limiting.
 * Enforces MAX_REQUESTS_PER_MIN and MAX_TOKENS_PER_MIN.
 */

import getConfig from "../config/index.js";
import logger from "../utils/logger.js";
import { sleep } from "../utils/delay.js";

const WINDOW_MS = 60_000;

// Sliding window state
interface TimestampEntry {
  ts: number;
}
interface TokenEntry {
  ts: number;
  tokens: number;
}

const requestLog: TimestampEntry[] = [];
const tokenLog: TokenEntry[] = [];

// Priority queue
interface QueueEntry {
  priority: number;
  tokens: number;
  resolve: () => void;
  enqueuedAt: number;
}

const queue: QueueEntry[] = [];
let processing = false;

// Helpers
function pruneWindow<T extends { ts: number }>(log: T[], now: number): void {
  while (log.length > 0 && log[0].ts <= now - WINDOW_MS) {
    log.shift();
  }
}

function currentRequestsInWindow(): number {
  pruneWindow(requestLog, Date.now());
  return requestLog.length;
}

function currentTokensInWindow(): number {
  pruneWindow(tokenLog, Date.now());
  return tokenLog.reduce((sum, e) => sum + e.tokens, 0);
}

function msUntilSlotAvailable(estimatedTokens: number): number {
  const now = Date.now();
  pruneWindow(requestLog, now);
  pruneWindow(tokenLog, now);

  const { maxRequestsPerMin, maxTokensPerMin } = getConfig().rateLimit;
  let waitMs = 0;

  if (requestLog.length >= maxRequestsPerMin) {
    const oldestReq = requestLog[0].ts;
    waitMs = Math.max(waitMs, oldestReq + WINDOW_MS - now + 50);
  }

  const currentTokens = tokenLog.reduce((s, e) => s + e.tokens, 0);
  if (currentTokens + estimatedTokens > maxTokensPerMin) {
    let cumulative = 0;
    for (const entry of tokenLog) {
      cumulative += entry.tokens;
      if (currentTokens - cumulative + estimatedTokens <= maxTokensPerMin) {
        waitMs = Math.max(waitMs, entry.ts + WINDOW_MS - now + 50);
        break;
      }
    }
  }

  return waitMs;
}

// Queue processor
async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    queue.sort((a, b) => b.priority - a.priority);

    const next = queue[0];
    const waitMs = msUntilSlotAvailable(next.tokens);

    if (waitMs > 0) {
      logger.info("⏳ Rate limiter delaying request", {
        waitMs,
        queueSize: queue.length,
        reqsInWindow: currentRequestsInWindow(),
        tokensInWindow: currentTokensInWindow(),
      });
      await sleep(waitMs);
      continue;
    }

    queue.shift();
    const now = Date.now();
    requestLog.push({ ts: now });
    tokenLog.push({ ts: now, tokens: next.tokens });

    logger.debug("Rate limiter slot acquired", {
      tokens: next.tokens,
      queuedForMs: now - next.enqueuedAt,
      remainingQueue: queue.length,
    });

    next.resolve();
  }

  processing = false;
}

// Public API
export function acquireSlot(
  estimatedTokens: number,
  priority = 0,
): Promise<void> {
  return new Promise((resolve) => {
    queue.push({
      priority,
      tokens: estimatedTokens,
      resolve,
      enqueuedAt: Date.now(),
    });
    processQueue();
  });
}

export interface RateLimiterMetrics {
  queueSize: number;
  requestsPerMin: number;
  tokensPerMin: number;
}

export function getMetrics(): RateLimiterMetrics {
  return {
    queueSize: queue.length,
    requestsPerMin: currentRequestsInWindow(),
    tokensPerMin: currentTokensInWindow(),
  };
}
