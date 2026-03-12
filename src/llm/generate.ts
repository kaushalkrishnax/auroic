/**
 * LLM text generation — used by the "text" action handler.
 *
 * Sends history + candidates context to the LLM for reply generation.
 */

import getConfig from "@/runtime/index.js";
import logger from "@/utils/logger.js";
import { chatCompletion, resolveModel } from "@/llm/client.js";
import type { ChatMessage } from "@/llm/client.js";
import type { EffortLevel } from "@/types/index.js";

export async function generateReply(
  history: string[],
  candidates: string[],
  effort: EffortLevel,
): Promise<string> {
  const config = getConfig();
  const model = resolveModel(effort);
  const systemPrompt = config.llm.systemPrompt;

  const h = [...history];
  while (h.length < 5) h.unshift("...");

  const historyText = h.map((msg, i) => `H${i + 1}: ${msg}`).join("\n");
  const targetText = candidates[0] ?? "";

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: historyText },
    { role: "assistant", content: "ok" },
    { role: "user", content: targetText },
  ];

  logger.info("LLM generate", { model, effort });
  return chatCompletion(messages, model);
}
