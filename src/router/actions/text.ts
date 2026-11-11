/**
 * Action: text
 * Generates a reply using the LLM generation module and sends it.
 *
 * Enforces a strict validation boundary between reply generation and Instagram delivery.
 */

import logger from "@/utils/logger.js";
import { sendText } from "@/automation/chat.js";
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

  let replyText: string;
  try {
    replyText = await generateReply(
      cleanHistory,
      cleanGeneratorCandidates,
      decision.effort,
    );
  } catch (err) {
    logger.error("Text action failed: LLM reply generation failed", {
      chatId,
      target: decision.target,
      effort: decision.effort,
      error: (err as Error).message,
      outcome: "generation_failed",
    });
    return null;
  }

  // Strict validation boundary: ensure generated response is a non-empty string before delivery
  const trimmedReply = typeof replyText === "string" ? replyText.trim() : "";
  if (!trimmedReply) {
    logger.error("Text action rejected: generated reply is empty or invalid", {
      chatId,
      target: decision.target,
      effort: decision.effort,
      outcome: "empty_generation_rejected",
    });
    return null;
  }

  logger.info("Sending text reply", {
    chatId,
    preview: trimmedReply.slice(0, 80),
  });

  const sent = await sendText(
    trimmedReply,
    chatId,
    context.targetMessageId ?? undefined,
  );

  if (!sent) {
    logger.warn("Text action delivery failed: sendText returned false", {
      chatId,
      targetMessageId: context.targetMessageId,
      outcome: "delivery_failed",
    });
    return null;
  }

  logger.info("Text action completed successfully", {
    chatId,
    targetMessageId: context.targetMessageId,
    outcome: "success",
  });
  return trimmedReply;
}
