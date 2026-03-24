import logger from "@/utils/logger.js";

let queueTail: Promise<void> = Promise.resolve();

/**
 * Serializes browser automation steps (navigation/sending/reactions/media)
 * so concurrent pipeline paths cannot race against each other.
 */
export async function runWithAutomationLock<T>(
  label: string,
  chatId: string,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();

  logger.debug("Automation lock: queued", { label, chatId });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const previous = queueTail;
  queueTail = previous.finally(() => gate);

  await previous;

  logger.debug("Automation lock: acquired", { label, chatId });

  try {
    return await task();
  } finally {
    release();
    const heldForMs = Date.now() - startedAt;
    const releaseDetails = {
      label,
      chatId,
      heldForMs,
    };

    if (heldForMs >= 1500) {
      logger.info("Automation lock: released", releaseDetails);
    } else {
      logger.debug("Automation lock: released", releaseDetails);
    }
  }
}
