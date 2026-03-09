/**
 * LLM translation — used by the "translate" action handler.
 */

import getConfig from "@/runtime/index.js";
import logger from "@/utils/logger.js";
import { chatCompletion, resolveModel } from "@/llm/client.js";
import type { ChatMessage } from "@/llm/client.js";
import type { EffortLevel } from "@/types/index.js";

export async function translateText(
  targetText: string,
  title: string,
  routerEffort: EffortLevel | null,
): Promise<string> {
  const config = getConfig();

  // Determine effort: config can override with a fixed level, or "auto" uses router's suggestion
  let effort: EffortLevel;
  const translateConfig = config.llm.translate.effort;
  if (translateConfig === "auto") {
    effort = routerEffort ?? "medium";
  } else {
    effort = translateConfig as EffortLevel;
  }

  const model = resolveModel(effort);
  const systemPrompt =
    "You are a translator. Translate the given text accurately. Output only the translation, nothing else.";

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${title}\n\nText to translate:\n${targetText}` },
  ];

  logger.info("LLM translate", { model, effort, title });
  return chatCompletion(messages, model);
}
