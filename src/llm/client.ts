/**
 * LLM client — effort-based model selection and OpenAI-compatible chat completion.
 */

import getConfig from "@/runtime/index.js";
import type { EffortLevel } from "@/types/index.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Resolve model name from effort level. */
export function resolveModel(effort: EffortLevel): string {
  const config = getConfig();
  return config.llm.models[effort];
}

/** Call the OpenAI-compatible chat completion API. */
export async function chatCompletion(
  messages: ChatMessage[],
  model: string,
): Promise<string> {
  const config = getConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.output.timeout);

  try {
    const res = await fetch(config.llm.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: config.llm.output.maxTokens,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM API ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      choices: [{ message: { content: string } }];
    };
    return data.choices[0].message.content
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim();
  } finally {
    clearTimeout(timer);
  }
}
