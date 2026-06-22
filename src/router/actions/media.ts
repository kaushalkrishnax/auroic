/**
 * Action: media
 * Send a GIF in response to a message.
 * Uses the TITLE field as a 2-3 word natural language search query.
 */

import logger from "@/utils/logger.js";
import type { ActionContext } from "@/types/index.js";

export async function executeMedia(
  context: ActionContext,
): Promise<string | null> {
  const { title } = context.decision;

  const query = title || "funny";
  logger.info("Action: media", { chatId: context.chatId, query });

  const core = context.core;
  const sent = core
    ? await core.sendMedia(
        context.chatId,
        query,
        context.targetMessageId ?? undefined,
      )
    : false;

  if (!sent) {
    logger.warn("Media action skipped: target unavailable or media not found", {
      chatId: context.chatId,
      targetMessageId: context.targetMessageId,
      query,
    });
    return null;
  }

  return query;
}
