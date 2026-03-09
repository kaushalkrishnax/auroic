/**
 * Action: translate
 * Uses the LLM translation module to translate the target message.
 */

import logger from "@/utils/logger.js";
import { sendText } from "@/automation/chat.js";
import { translateText } from "@/llm/translate.js";
import type { ActionContext } from "@/types/index.js";

export async function executeTranslate(
  context: ActionContext,
): Promise<string | null> {
  const { chatId, decision } = context;

  logger.info("Action: translate", {
    chatId,
    title: decision.title,
    target: decision.target,
  });

  if (!decision.title || !context.targetTextBody) {
    logger.warn("Translate action missing title or target text — skipping");
    return null;
  }

  try {
    const translated = await translateText(
      context.targetTextBody,
      decision.title,
      decision.effort,
    );

    logger.info("Sending translation", {
      chatId,
      preview: translated.slice(0, 80),
    });

    await sendText(translated, chatId, context.targetMid ?? undefined);

    return translated;
  } catch (err) {
    logger.error("Failed to execute translate action", {
      chatId,
      error: (err as Error).message,
    });
    return null;
  }
}
