/**
 * Generic async retry with exponential backoff.
 *
 * Handles HTTP 429 (rate limited) and 503 (service unavailable)
 * with Retry-After header support. Never crashes the worker.
 */

import { sleep } from "./delay.js";
import logger from "./logger.js";
import type { AxiosError } from "axios";

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
}

export async function retry<T>(
  fn: () => Promise<T>,
  {
    maxAttempts = 3,
    baseDelayMs = 1000,
    label = "operation",
  }: RetryOptions = {},
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const error = err as AxiosError;
      lastError = error;

      let delayMs = baseDelayMs * 2 ** (attempt - 1);
      let isRateLimit = false;

      if (error.response) {
        const status = error.response.status;
        if (status === 429 || status === 503) {
          isRateLimit = true;
          const retryAfter = error.response.headers["retry-after"] as
            | string
            | undefined;

          if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed)) {
              delayMs = parsed * 1000;
            } else {
              const date = new Date(retryAfter);
              if (!isNaN(date.getTime())) {
                delayMs = Math.max(0, date.getTime() - Date.now());
              }
            }
            delayMs = Math.max(delayMs, 500);
          }

          logger.warn(
            `${label} rate limited (${status}), attempt ${attempt}/${maxAttempts}, waiting ${delayMs}ms`,
            {
              status,
              retryAfter: retryAfter || "not provided",
              error: error.message,
            },
          );
        }
      }

      if (!isRateLimit) {
        logger.warn(
          `${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`,
          { error: error.message },
        );
      }

      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}
