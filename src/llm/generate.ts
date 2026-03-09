/**
 * LLM text generation — used by the "text" action handler.
 *
 * Sends the 5-message window to the LLM with the router's title as a framing hint.
 */

import getConfig from "@/runtime/index.js";
import logger from "@/utils/logger.js";
import { chatCompletion, resolveModel } from "@/llm/client.js";
import type { ChatMessage } from "@/llm/client.js";
import type { EffortLevel } from "@/types/index.js";

export async function generateReply(
  window: string[],
  title: string,
  effort: EffortLevel,
): Promise<string> {
  const config = getConfig();
  const model = resolveModel(effort);
  const systemPrompt = config.llm.systemPrompt;

  const windowText = window.map((msg, i) => `M${i + 1}: ${msg}`).join("\n");

  const userContent = [
    `Here is a conversation window (M1=oldest, M5=newest):`,
    windowText,
    ``,
    `Router hint: "${title}"`,
    `Reply to the conversation as a natural participant. Your reply targets M5.`,
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  logger.info("LLM generate", { model, effort, title });
  return chatCompletion(messages, model);
}
