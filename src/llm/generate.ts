/**
 * LLM text generation — used by the "text" action handler.
 *
 * Sends history + candidates context to the LLM for reply generation with
 * bounded retries, explicit retry guidance, model fallback, and structured observability.
 */

import getConfig from "@/runtime/index.js";
import logger from "@/utils/logger.js";
import {
  chatCompletionDetailed,
  resolveModel,
  sanitizeUrl,
  LLMError,
} from "@/llm/client.js";
import type { ChatMessage, ChatCompletionOptions } from "@/llm/client.js";
import type { EffortLevel } from "@/types/index.js";

/** Determine a candidate fallback model from configured models */
function resolveFallbackModel(effort: EffortLevel, primaryModel: string): string | null {
  const config = getConfig();
  const models = config.llm.models;
  if (!models) return null;

  let candidate: string | undefined;
  if (effort === "medium") {
    candidate = models.low !== primaryModel ? models.low : models.high;
  } else if (effort === "high") {
    candidate = models.medium !== primaryModel ? models.medium : models.low;
  } else {
    // low
    candidate = models.medium !== primaryModel ? models.medium : models.high;
  }

  if (candidate && candidate.trim() && candidate !== primaryModel) {
    return candidate.trim();
  }
  return null;
}

export async function generateReply(
  history: string[],
  candidates: string[],
  effort: EffortLevel,
): Promise<string> {
  const config = getConfig();
  const primaryModel = resolveModel(effort);
  const fallbackModel = resolveFallbackModel(effort, primaryModel);
  const providerUrl = sanitizeUrl(config.llm.url);

  const recentHistory = history
    .slice(-10)
    .map((msg) => msg.replace(/@BOT/gi, "").trim())
    .filter(Boolean)
    .join("\n");

  const target = (candidates[0] ?? "").replace(/@BOT/gi, "").trim();

  // Retry policy:
  // Attempt 1: primary model, standard prompt
  // Attempt 2: primary model retry with explicit prompt & increased token limit if truncated
  // Attempt 3 (optional): fallback model if attempt 2 failed and fallback model is configured
  const maxPrimaryAttempts = 2;
  const maxTotalAttempts = fallbackModel ? maxPrimaryAttempts + 1 : maxPrimaryAttempts;

  let lastError: Error | null = null;
  let lastCategory = "unknown";
  let lastFinishReason: string | null = null;

  for (let attempt = 1; attempt <= maxTotalAttempts; attempt++) {
    const isFallback = attempt > maxPrimaryAttempts;
    const currentModel = isFallback ? fallbackModel! : primaryModel;
    const isRetry = attempt > 1;

    // Prompt construction:
    // On retry, explicitly instruct the model to produce a concise user-facing reply with no thinking/prefix.
    const retryGuidance =
      "IMPORTANT: Respond directly to the user with a concise, natural reply (2-12 words). " +
      "Do NOT output internal reasoning, thinking tags (<think>), prefixes, or blank responses.";

    const contextPrompt = [
      recentHistory && `Recent conversation:\n${recentHistory}`,
      `Reply to: ${target}`,
      isRetry
        ? retryGuidance
        : "Reply naturally. Do not start your reply with any tag, label, or prefix.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: config.llm.systemPrompt },
      { role: "user", content: contextPrompt },
    ];

    // If previous attempt was truncated by token limit, increase maxTokens headroom
    const options: ChatCompletionOptions = {};
    if (lastFinishReason === "length") {
      options.maxTokens = Math.max((config.llm.output.maxTokens ?? 150) * 2, 250);
    }

    try {
      const result = await chatCompletionDetailed(messages, currentModel, options);

      logger.info("LLM generation succeeded", {
        model: currentModel,
        provider: providerUrl,
        attempt,
        finishReason: result.finishReason ?? undefined,
        fallbackUsed: isFallback,
        finalOutcome: "success",
      });

      return result.content;
    } catch (err) {
      lastError = err as Error;

      let category = "provider_request_failure";
      let finishReason: string | null = null;
      let isRetryable = true;

      if (err instanceof LLMError) {
        category = err.category;
        finishReason = err.finishReason ?? null;
        isRetryable = err.isRetryable;
      }

      lastCategory = category;
      lastFinishReason = finishReason;

      const hasNextAttempt = attempt < maxTotalAttempts;
      const willRetry = isRetryable && hasNextAttempt;

      logger.warn("LLM generation attempt failed", {
        model: currentModel,
        provider: providerUrl,
        attempt,
        maxAttempts: maxTotalAttempts,
        category,
        finishReason: finishReason ?? undefined,
        retryAttempted: willRetry,
        fallbackAttempted: isFallback,
        error: (err as Error).message,
      });

      // Permanent failures (e.g. 401/403 auth errors, invalid endpoint 404) must not be retried
      if (!isRetryable) {
        break;
      }
    }
  }

  logger.error("LLM generation failed after all attempts", {
    model: primaryModel,
    provider: providerUrl,
    totalAttempts: maxTotalAttempts,
    category: lastCategory,
    finishReason: lastFinishReason ?? undefined,
    finalOutcome: "failure",
  });

  throw lastError ?? new Error("LLM generation failed");
}
