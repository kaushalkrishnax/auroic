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

export type ReplyFormat = "text" | "multimodal";

/**
 * Compact output contract for multimodal replies. Keep this in sync with
 * `parseResponse` in src/response/protocol.ts: only these four token types are
 * parsed, every token needs a non-empty value, and text outside tokens is sent
 * as its own message.
 */
const MULTIMODAL_INSTRUCTIONS = [
  "OUTPUT FORMAT (required):",
  "Reply in the persona using plain text. You may interleave:",
  "- [sticker: short visual description]",
  "- [gif: short visual search description]",
  "- [voice: exact words to speak]",
  "- [music: song title or artist]",
  "Rules:",
  "- One natural reply; tokens stay inline and in order.",
  "- Only these four token types, each with a non-empty value.",
  "- No JSON, code fences, nested tokens, or explanation of tokens.",
  "- Text outside tokens is sent as a message. Usually 0-2 media tokens.",
].join("\n");

export async function generateReply(
  history: string[],
  candidates: string[],
  effort: EffortLevel,
  format: ReplyFormat = "text",
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
      format === "multimodal"
        ? "Retry: return a complete reply using plain text and, optionally, supported tokens with non-empty values. Never return an empty response."
        : "IMPORTANT: Respond directly to the user with a concise, natural reply (2-12 words). Do NOT output internal reasoning, thinking tags (<think>), prefixes, or blank responses.";

    const contextPrompt = [
      recentHistory && `Recent conversation:\n${recentHistory}`,
      `Reply to: ${target}`,
      isRetry
        ? retryGuidance
        : format === "multimodal"
          ? "Use the persona and output format above. Reply naturally to the last message."
          : "Reply naturally. Do not start your reply with any tag, label, or prefix.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const protocolInstructions =
      format === "multimodal" ? MULTIMODAL_INSTRUCTIONS : "";

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: format === "multimodal"
          ? `${protocolInstructions}\n\nUSER PERSONA AND STYLE PROMPT:\n${config.llm.systemPrompt}`
          : config.llm.systemPrompt,
      },
      { role: "user", content: contextPrompt },
    ];

    // If previous attempt was truncated by token limit, increase maxTokens headroom
    const options: ChatCompletionOptions = {};
    if (format === "multimodal") {
      options.maxTokens = Math.max(config.llm.output.maxTokens ?? 150, 500);
    }
    if (lastFinishReason === "length") {
      options.maxTokens = Math.max((config.llm.output.maxTokens ?? 150) * 2, 250);
    }

    try {
      const result = await chatCompletionDetailed(messages, currentModel, options);

      logger.info("LLM generation succeeded", {
        model: currentModel,
        provider: providerUrl,
        attempt,
        content: result.content,
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
