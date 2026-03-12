import logger from "@/utils/logger.js";
import { addReaction } from "@/automation/chat.js";
import type { ActionContext } from "@/types/index.js";

export async function executeReact(
  context: ActionContext,
): Promise<string | null> {
  const { chatId, decision } = context;

  logger.info("Action: react", {
    chatId,
    title: decision.title,
    target: decision.target,
  });

  if (!decision.title) {
    logger.warn("React action missing title — skipping");
    return null;
  }

  if (!context.targetMessageId) {
    logger.warn("React action missing target message id — skipping");
    return null;
  }

  await addReaction(decision.title, chatId, context.targetMessageId);

  return decision.title;
}
