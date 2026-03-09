import logger from "@/utils/logger.js";
import type { ActionContext } from "@/types/index.js";

export async function executeIgnore(context: ActionContext): Promise<void> {
  logger.info("Action: ignore", {
    chatId: context.chatId,
    messageId: context.message.id,
  });
}
