/**
 * Typing simulation.
 *
 * Produces human-like typing activity in the Instagram message input
 * while the AI response is being fetched.
 */

import type { Page } from "playwright-core";
import SELECTORS from "../instagram/selectors.js";
import config from "../config/index.js";
import logger from "../utils/logger.js";
import { sleep } from "../utils/delay.js";

const CHARS = "abcdefghijklmnopqrstuvwxyz     ";

function randomChar(): string {
  return CHARS[Math.floor(Math.random() * CHARS.length)];
}

function keystrokeDelay(): number {
  const { minDelayMs, maxDelayMs } = config.typing;
  return Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
}

export interface TypingHandle {
  finishAfterResponse: (replyText: string) => Promise<void>;
}

export function startTypingSimulation(page: Page): TypingHandle {
  let shouldStop = false;
  let typedCount = 0;
  const startTime = Date.now();

  const typingLoop = (async () => {
    try {
      const input = page.locator(SELECTORS.messageInput).first();
      await input.click({ timeout: 5_000 });

      while (!shouldStop) {
        await input.pressSequentially(randomChar(), { delay: 0 });
        typedCount++;
        await sleep(keystrokeDelay());

        if (typedCount > 3 && Math.random() < 0.3) {
          const deleteCount = Math.min(
            typedCount,
            Math.floor(Math.random() * 3) + 1,
          );
          for (let d = 0; d < deleteCount; d++) {
            await input.press("Backspace");
            typedCount--;
            await sleep(keystrokeDelay() / 2);
          }
        }

        if (typedCount > 30) {
          for (let d = 0; d < typedCount; d++) {
            await input.press("Backspace");
            await sleep(10);
          }
          typedCount = 0;
        }
      }

      if (typedCount > 0) {
        for (let d = 0; d < typedCount + 5; d++) {
          await input.press("Backspace");
          await sleep(10);
        }
      }
      await input.fill("");
    } catch (err) {
      logger.warn("Typing simulation encountered an error", {
        error: (err as Error).message,
      });
    }
  })();

  return {
    async finishAfterResponse(replyText: string): Promise<void> {
      const lengthBasedMs = replyText.length * 50;
      const extraMs = Math.max(
        config.typing.postResponseMs,
        Math.min(lengthBasedMs, 5_000),
      );

      const elapsed = Date.now() - startTime;
      const minTotalMs = 1_000;
      const remainingForMinimum = Math.max(0, minTotalMs - elapsed);
      const waitMs = Math.max(extraMs, remainingForMinimum);

      logger.debug("Continuing typing after AI response", {
        extraMs: waitMs,
        elapsedMs: elapsed,
      });
      await sleep(waitMs);

      shouldStop = true;
      await typingLoop;

      const totalMs = Date.now() - startTime;
      logger.info("Typing simulation complete", { totalDurationMs: totalMs });
    },
  };
}
