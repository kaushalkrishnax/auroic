import logger from "@/utils/logger.js";

/**
 * Per-chat serialization for browser automation steps.
 *
 * Actions for the same chat run one at a time, while different chats can run
 * independently on their own assigned tabs.
 */
const queues = new Map<string, Promise<void>>();

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

  const previous = queues.get(chatId) ?? Promise.resolve();
  const current = previous.then(() => gate);
  queues.set(chatId, current);

  await previous;

  logger.debug("Automation lock: acquired", { label, chatId });

  try {
    return await task();
  } finally {
    release();
    if (queues.get(chatId) === current) queues.delete(chatId);

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
