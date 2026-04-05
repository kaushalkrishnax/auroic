/**
 * LLM text generation — used by the "text" action handler.
 *
 * Sends history + candidates context to the LLM for reply generation.
 */

import getConfig from "@/runtime/index.js";
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

  const recentHistory = history
    .slice(-10)
    .map((msg) => msg.replace(/@BOT/gi, "").trim())
    .filter(Boolean)
    .join("\n");

  const target = (candidates[0] ?? "").replace(/@BOT/gi, "").trim();

  const contextPrompt = [
    recentHistory && `Recent conversation:\n${recentHistory}`,
    `Reply to: ${target}`,
    "Reply naturally. Do not start your reply with any tag, label, or prefix.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: config.llm.systemPrompt },
    { role: "user", content: contextPrompt },
  ];

  const reply = await chatCompletion(messages, model);
  return reply.replace(/@BOT/gi, "").trim();
}
