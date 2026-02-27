/**
 * AI API client.
 *
 * Sends user messages to an OpenAI-compatible endpoint.
 * Includes rate limiting, token budgeting, history trimming, and retry.
 */

import axios from "axios";
import config from "../config/index.js";
import logger from "../utils/logger.js";
import { retry } from "../utils/retry.js";
import { estimateTokens, estimateMessagesTokens } from "./tokenEstimator.js";
import { acquireSlot } from "./rateLimiter.js";
import type { ChatMessage } from "./tokenEstimator.js";

// History trimming

function trimHistory(history: string[]): string[] {
  if (!history || history.length === 0) return [];

  let trimmed = history.slice(-config.history.maxMessages);

  const maxTokens = config.history.maxTokens;
  let totalTokens = trimmed.reduce((sum, msg) => sum + estimateTokens(msg), 0);

  while (trimmed.length > 0 && totalTokens > maxTokens) {
    const removed = trimmed.shift()!;
    totalTokens -= estimateTokens(removed);
  }

  return trimmed;
}

// Main API function

interface GetAIReplyParams {
  user: string;
  message: string;
  history?: string[];
  conversationId: string;
  priority?: number;
}

export async function getAIReply({
  user,
  message,
  history = [],
  conversationId,
  priority = 0,
}: GetAIReplyParams): Promise<string> {
  const trimmedHistory = trimHistory(history);

  logger.info("Sending message to AI API", {
    user,
    conversationId,
    historyLength: trimmedHistory.length,
    priority,
  });

  const systemPrompt = `${config.ai.systemPrompt}\nYou are replying to messages on Instagram as ${config.instagram.username}. Reply naturally and concisely to the message from user '${user}'.`;

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

  for (const msg of trimmedHistory) {
    if (msg !== message) {
      messages.push({ role: "user", content: msg });
    }
  }

  messages.push({ role: "user", content: message });

  const inputTokens = estimateMessagesTokens(messages);
  const estimatedTotalTokens = inputTokens + config.output.maxTokens;

  logger.debug("Token estimation", {
    inputTokens,
    maxOutputTokens: config.output.maxTokens,
    estimatedTotal: estimatedTotalTokens,
  });

  await acquireSlot(estimatedTotalTokens, priority);

  const payload = {
    model: config.ai.model,
    messages,
    temperature: 0.7,
    max_tokens: config.output.maxTokens,
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.ai.key}`,
  };

  const response = await retry(
    async () => {
      const res = await axios.post(config.ai.url, payload, {
        timeout: config.ai.timeout,
        headers,
      });
      return res.data;
    },
    {
      maxAttempts: config.retry.maxAttempts,
      baseDelayMs: config.retry.baseDelayMs,
      label: "AI API request",
    },
  );

  const reply = response.choices?.[0]?.message?.content;
  if (!reply || typeof reply !== "string") {
    throw new Error("AI API returned an invalid empty response body");
  }

  logger.info("Received AI reply", { conversationId, length: reply.length });
  return reply.trim();
}
