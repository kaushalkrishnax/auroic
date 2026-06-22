/**
 * Action: text
 * Generates a reply using the LLM generation module and sends it.
 */

import logger from "@/utils/logger.js";
import { generateReply } from "@/llm/generate.js";
import type { ActionContext } from "@/types/index.js";

export async function executeText(
  context: ActionContext,
): Promise<string | null> {
  const { chatId, decision, history, candidates, targetTextContent } = context;

  logger.info("Action: text", {
    chatId,
    target: decision.target,
    effort: decision.effort,
  });

  if (!decision.effort) {
    logger.warn("Text action missing effort level", decision);
    return null;
  }

  // Only expose the target candidate to the generator — other candidates are irrelevant noise.
  const generatorCandidates = targetTextContent
    ? [targetTextContent]
    : candidates;

  const cleanGeneratorCandidates = generatorCandidates.map((c) =>
    c.replace(/@BOT/gi, "").trim(),
  );

  const cleanHistory = history.map((h) => h.replace(/@BOT/gi, "").trim());

  try {
    const replyText = await generateReply(
      cleanHistory,
      cleanGeneratorCandidates,
      decision.effort,
    );

    logger.info("Sending text reply", {
      chatId,
      preview: replyText.slice(0, 80),
    });

    const core = context.core;
    const sent = core
      ? await core.sendText(
          chatId,
          replyText,
          context.targetMessageId ?? undefined,
        )
      : false;

    if (!sent) {
      logger.warn("Text action skipped: target unavailable or send failed", {
        chatId,
        targetMessageId: context.targetMessageId,
      });
      return null;
    }

    return replyText;
  } catch (err) {
    logger.error("Failed to execute text action", {
      chatId,
      error: (err as Error).message,
    });
    return null;
  }
}
