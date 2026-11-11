/**
 * LLM client — effort-based model selection and OpenAI-compatible chat completion.
 */

import getConfig from "@/runtime/index.js";
import type { EffortLevel } from "@/types/index.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  maxTokens?: number;
  timeout?: number;
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  content: string;
  rawContent: string | null;
  finishReason: string | null;
  model: string;
}

export type GenerationFailureCategory =
  | "provider_request_failure"
  | "provider_response_parsing_failure"
  | "empty_generation"
  | "invalid_generation"
  | "generation_timeout"
  | "authentication_failure"
  | "configuration_error";

export class LLMError extends Error {
  readonly category: GenerationFailureCategory;
  readonly isRetryable: boolean;
  readonly status?: number;
  readonly finishReason?: string | null;

  constructor(
    message: string,
    category: GenerationFailureCategory,
    isRetryable: boolean,
    status?: number,
    finishReason?: string | null,
  ) {
    super(message);
    this.name = "LLMError";
    this.category = category;
    this.isRetryable = isRetryable;
    this.status = status;
    this.finishReason = finishReason;
  }
}

/** Sanitize URL to avoid leaking credentials or sensitive query parameters in logs */
export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return "unknown_provider";
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return rawUrl.split("?")[0] ?? "unknown_provider";
  }
}

/**
 * Strips reasoning / thought blocks (<think>, <thought>, <reasoning>) from text.
 * Safely removes closed tags and trailing unclosed tags (e.g. when generation was truncated).
 * Preserves any user-facing text before, between, or after tags.
 */
export function stripReasoning(text: string): { cleaned: string; hadReasoning: boolean } {
  if (!text) return { cleaned: "", hadReasoning: false };

  let hadReasoning = false;

  // Check for closed reasoning blocks
  if (
    /<think>[\s\S]*?<\/think>/i.test(text) ||
    /<thought>[\s\S]*?<\/thought>/i.test(text) ||
    /<reasoning>[\s\S]*?<\/reasoning>/i.test(text)
  ) {
    hadReasoning = true;
  }

  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");

  // Check for unclosed trailing reasoning blocks (e.g. truncated generation)
  if (
    /<think>[\s\S]*$/i.test(cleaned) ||
    /<thought>[\s\S]*$/i.test(cleaned) ||
    /<reasoning>[\s\S]*$/i.test(cleaned)
  ) {
    hadReasoning = true;
    cleaned = cleaned
      .replace(/<think>[\s\S]*$/gi, "")
      .replace(/<thought>[\s\S]*$/gi, "")
      .replace(/<reasoning>[\s\S]*$/gi, "");
  }

  return { cleaned: cleaned.trim(), hadReasoning };
}

/** Resolve model name from effort level. */
export function resolveModel(effort: EffortLevel): string {
  const config = getConfig();
  return config.llm.models[effort];
}

/**
 * Builds request payload body handling model-specific parameter conventions
 * (e.g., max_completion_tokens for o1/o3-family reasoning models).
 */
function buildRequestBody(
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  useMaxCompletionTokens: boolean,
): string {
  const isReasoningModel = /^o[13](-|$)/i.test(model);
  const payload: Record<string, unknown> = {
    model,
    messages,
  };

  if (useMaxCompletionTokens || isReasoningModel) {
    payload.max_completion_tokens = maxTokens;
  } else {
    payload.max_tokens = maxTokens;
  }

  return JSON.stringify(payload);
}

/**
 * Call the OpenAI-compatible chat completion API with comprehensive validation,
 * error classification, reasoning tag stripping, and provider compatibility handling.
 */
export async function chatCompletionDetailed(
  messages: ChatMessage[],
  model: string,
  options?: ChatCompletionOptions,
): Promise<ChatCompletionResult> {
  const config = getConfig();

  if (!config.llm.url || !config.llm.url.trim()) {
    throw new LLMError(
      "LLM API URL is not configured",
      "configuration_error",
      false,
    );
  }

  const timeoutMs = options?.timeout ?? config.llm.output.timeout ?? 30000;
  const maxTokens = options?.maxTokens ?? config.llm.output.maxTokens ?? 150;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const combinedSignal = options?.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.llm.key && config.llm.key.trim()) {
    headers["Authorization"] = `Bearer ${config.llm.key.trim()}`;
  }

  let useMaxCompletionTokens = false;

  try {
    let res: Response;
    try {
      res = await fetch(config.llm.url, {
        method: "POST",
        headers,
        body: buildRequestBody(model, messages, maxTokens, useMaxCompletionTokens),
        signal: combinedSignal,
      });

      // Handle 400 that specifically requests max_completion_tokens instead of max_tokens
      if (res.status === 400 && !useMaxCompletionTokens) {
        const errBody = await res.text();
        if (errBody.includes("max_completion_tokens")) {
          useMaxCompletionTokens = true;
          res = await fetch(config.llm.url, {
            method: "POST",
            headers,
            body: buildRequestBody(model, messages, maxTokens, true),
            signal: combinedSignal,
          });
        } else {
          throw new LLMError(
            `LLM API 400 Bad Request: ${errBody}`,
            "invalid_generation",
            false,
            400,
          );
        }
      }
    } catch (err) {
      if (err instanceof LLMError) {
        throw err;
      }
      if (
        (err as Error).name === "AbortError" ||
        combinedSignal.aborted
      ) {
        throw new LLMError(
          `LLM API request timed out after ${timeoutMs}ms`,
          "generation_timeout",
          true,
        );
      }
      throw new LLMError(
        `LLM API network error: ${(err as Error).message}`,
        "provider_request_failure",
        true,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new LLMError(
          `LLM API authentication failed (${res.status}): ${body}`,
          "authentication_failure",
          false,
          res.status,
        );
      }
      if (res.status === 404) {
        throw new LLMError(
          `LLM API endpoint not found (404): ${body}`,
          "configuration_error",
          false,
          404,
        );
      }
      if (res.status === 429) {
        throw new LLMError(
          `LLM API rate limit exceeded (429): ${body}`,
          "provider_request_failure",
          true,
          429,
        );
      }
      if (res.status >= 500 && res.status < 600) {
        throw new LLMError(
          `LLM API server error (${res.status}): ${body}`,
          "provider_request_failure",
          true,
          res.status,
        );
      }
      throw new LLMError(
        `LLM API error (${res.status}): ${body}`,
        "provider_request_failure",
        false,
        res.status,
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      throw new LLMError(
        `Failed to parse LLM API response as JSON: ${(err as Error).message}`,
        "provider_response_parsing_failure",
        true,
      );
    }

    if (!data || typeof data !== "object") {
      throw new LLMError(
        "Invalid LLM API response: body is not a JSON object",
        "provider_response_parsing_failure",
        true,
      );
    }

    const jsonRecord = data as Record<string, unknown>;

    if (jsonRecord.error) {
      const errObj = jsonRecord.error;
      const errMsg =
        typeof errObj === "object" && errObj !== null
          ? (errObj as Record<string, unknown>).message ?? JSON.stringify(errObj)
          : String(errObj);
      throw new LLMError(
        `Provider returned error: ${errMsg}`,
        "provider_request_failure",
        false,
      );
    }

    const choices = Array.isArray(jsonRecord.choices) ? jsonRecord.choices : null;
    if (!choices || choices.length === 0) {
      throw new LLMError(
        "Invalid LLM API response: missing or empty 'choices' array",
        "provider_response_parsing_failure",
        true,
      );
    }

    const firstChoice = choices[0];
    if (!firstChoice || typeof firstChoice !== "object") {
      throw new LLMError(
        "Invalid LLM API response: choice[0] is not an object",
        "provider_response_parsing_failure",
        true,
      );
    }

    const choiceRecord = firstChoice as Record<string, unknown>;
    const finishReason =
      typeof choiceRecord.finish_reason === "string"
        ? choiceRecord.finish_reason
        : null;

    const message =
      choiceRecord.message && typeof choiceRecord.message === "object"
        ? (choiceRecord.message as Record<string, unknown>)
        : null;

    if (message?.refusal) {
      throw new LLMError(
        `Model refused to respond: ${String(message.refusal)}`,
        "invalid_generation",
        false,
        undefined,
        finishReason,
      );
    }

    if (finishReason === "content_filter") {
      throw new LLMError(
        "Model response was blocked by content filter",
        "invalid_generation",
        false,
        undefined,
        finishReason,
      );
    }

    // Extract content: prioritize message.content, fallback to choice.text (legacy completion)
    const messageContent = message?.content;
    const choiceText = typeof choiceRecord.text === "string" ? choiceRecord.text : null;
    const rawContent =
      typeof messageContent === "string"
        ? messageContent
        : choiceText;

    if (rawContent === null || rawContent === undefined) {
      const hasReasoningField = Boolean(
        message?.reasoning_content || message?.reasoning,
      );
      const msg = hasReasoningField
        ? "Model produced only reasoning content without user-facing reply"
        : "Model returned null or missing message content";
      throw new LLMError(msg, "empty_generation", true, undefined, finishReason);
    }

    const { cleaned, hadReasoning } = stripReasoning(rawContent);
    const trimmed = cleaned.replace(/@BOT/gi, "").trim();

    if (!trimmed) {
      const isTruncated = finishReason === "length";
      const msg = isTruncated
        ? "Model response was truncated before user-facing content (finish_reason: length)"
        : hadReasoning
        ? "Model response contained only reasoning or thinking tags"
        : "Model response content was empty or whitespace";
      throw new LLMError(msg, "empty_generation", true, undefined, finishReason);
    }

    return {
      content: trimmed,
      rawContent,
      finishReason,
      model,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Call the OpenAI-compatible chat completion API and return user-facing content. */
export async function chatCompletion(
  messages: ChatMessage[],
  model: string,
  options?: ChatCompletionOptions,
): Promise<string> {
  const result = await chatCompletionDetailed(messages, model, options);
  return result.content;
}
