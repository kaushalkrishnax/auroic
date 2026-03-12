/**
 * Action: media
 * Send a GIF in response to a message.
 * Uses the TITLE field as a 2-3 word natural language search query.
 */

import logger from "@/utils/logger.js";
import type { ActionContext } from "@/types/index.js";
import { sendStickerOrGIF } from "@/automation/chat.js";

export async function executeMedia(
  context: ActionContext,
): Promise<string | null> {
  const { title } = context.decision;

  const query = title || "funny";
  logger.info("Action: media", { chatId: context.chatId, query });

  await sendStickerOrGIF(
    query,
    context.chatId,
    context.targetMessageId ?? undefined,
  );

  return null;
}
