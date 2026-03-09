/**
 * Action: text
 * Generates a reply using the LLM generation module and sends it.
 */

import logger from "@/utils/logger.js";
import { sendText } from "@/automation/chat.js";
import { generateReply } from "@/llm/generate.js";
import type { ActionContext } from "@/types/index.js";

export async function executeText(
  context: ActionContext,
): Promise<string | null> {
  const { chatId, decision, window } = context;

  logger.info("Action: text", {
    chatId,
    target: decision.target,
    effort: decision.effort,
    title: decision.title,
  });

  if (!decision.effort || !decision.title) {
    logger.warn("Text action missing required fields (effort/title)", decision);
    return null;
  }

  try {
    const replyText = await generateReply(
      window,
      decision.title,
      decision.effort,
    );

    logger.info("Sending text reply", {
      chatId,
      preview: replyText.slice(0, 80),
    });

    await sendText(replyText, chatId, context.targetMid ?? undefined);

    return replyText;
  } catch (err) {
    logger.error("Failed to execute text action", {
      chatId,
      error: (err as Error).message,
    });
    return null;
  }
}
