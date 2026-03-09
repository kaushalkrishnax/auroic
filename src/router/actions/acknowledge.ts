import logger from "@/utils/logger.js";
import { sendText } from "@/automation/chat.js";
import type { ActionContext } from "@/types/index.js";

export async function executeAcknowledge(
  context: ActionContext,
): Promise<string | null> {
  const { chatId, decision } = context;

  logger.info("Action: acknowledge", { chatId, title: decision.title });

  if (!decision.title) {
    logger.warn("Acknowledge action missing title — skipping");
    return null;
  }

  const replyText = `[${decision.title}]`;

  await sendText(replyText, chatId, context.targetMid ?? undefined);
  return replyText;
}
