/**
 * Action: command (stub)
 * Placeholder for future command-handling capability.
 */

import logger from "@/utils/logger.js";
import type { ActionContext } from "@/types/index.js";

export async function executeCommand(
  context: ActionContext,
): Promise<string | null> {
  logger.info("Action: command (stub)", {
    chatId: context.chatId,
    title: context.decision.title,
    target: context.decision.target,
  });
  return null;
}
