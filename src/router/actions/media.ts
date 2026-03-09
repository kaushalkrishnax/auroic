/**
 * Action: media (stub)
 * Placeholder for future media-sending capability.
 */

import logger from "@/utils/logger.js";
import type { ActionContext } from "@/types/index.js";
import { sendGIF, sendSticker } from "@/automation/chat.js";

export async function executeMedia(
  context: ActionContext,
): Promise<string | null> {
  const { effort, title } = context.decision;

  switch (effort) {
    case "low":
      await sendSticker(
        title || "funny",
        context.chatId,
        context.targetMid ?? undefined,
      );
      break;

    case "medium":
      await sendGIF(
        title || "funny",
        context.chatId,
        context.targetMid ?? undefined,
      );
      break;

    case "high":
      await sendGIF(
        title || "funny",
        context.chatId,
        context.targetMid ?? undefined,
      );
      break;

    default:
      logger.warn(`Media action with unknown effort level: ${effort}`);
  }
  return null;
}
