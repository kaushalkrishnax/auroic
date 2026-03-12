/**
 * Router — classifies history + candidate messages and returns a routing decision.
 */

import { Ollama } from "ollama";
import getConfig from "@/runtime/index.js";
import logger from "@/utils/logger.js";
import type { RouterDecision, ActionType, EffortLevel } from "@/types/index.js";

let _ollama: Ollama | null = null;

function getOllama(): Ollama {
  if (!_ollama) {
    const config = getConfig();
    _ollama = new Ollama({ host: config.router.host });
  }
  return _ollama;
}

export function formatWindow(history: string[], candidates: string[]): string {
  const h = [...history];
  while (h.length < 5) h.unshift("...");

  // Align candidates to the right: 1 msg → C3, 2 msgs → C2+C3, 3 msgs → C1+C2+C3
  const c = [...candidates];
  while (c.length < 3) c.unshift("...");

  const lines = [
    ...h.map((msg, i) => `H${i + 1}: ${stripMentions(msg)}`),
    ...c.map((msg, i) => `C${i + 1}: ${stripMentions(msg, true)}`),
  ];
  return lines.join("\n");
}

function stripMentions(text: string, keepBot = false): string {
  const pattern = keepBot ? /@(?!BOT\b)\S+/gi : /@\S+/g;
  return text
    .replace(pattern, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseRouterOutput(output: string): RouterDecision {
  const decision: RouterDecision = {
    type: "ignore",
    target: null,
    effort: null,
    title: null,
    reason: null,
  };

  try {
    const thinkMatch = output.match(/<think>\s*([\s\S]*?)\s*<\/think>/);
    if (thinkMatch?.[1]) {
      decision.reason = thinkMatch[1].trim();
    }

    const rMatch = output.match(/R:\s*(.*)/);
    const parsePart = rMatch ? rMatch[1] : output;
    const regex = /([A-Z]+)\s*=\s*([^|\n,]+)/gi;
    let match;

    while ((match = regex.exec(parsePart)) !== null) {
      const key = match[1].trim().toUpperCase();
      const value = match[2].trim();
      if (!key || !value) continue;

      const lower = value.toLowerCase();

      switch (key) {
        case "TYPE":
          if (["text", "ignore", "react", "media"].includes(lower)) {
            decision.type = lower as ActionType;
          }
          break;
        case "TARGET": {
          if (lower === "null") {
            decision.target = null;
          } else {
            const slotMatch = value.match(/C(\d+)/i);
            if (slotMatch) {
              const slot = Math.min(parseInt(slotMatch[1], 10), 3);
              decision.target = `C${slot}`;
            } else {
              decision.target = value;
            }
          }
          break;
        }
        case "EFFORT":
          if (["low", "medium", "high"].includes(lower)) {
            decision.effort = lower as EffortLevel;
          }
          break;
        case "TITLE":
          decision.title = lower === "null" ? null : value;
          break;
      }
    }
  } catch (err) {
    logger.error("Failed to parse router output — defaulting to ignore", {
      output,
      error: (err as Error).message,
    });
  }

  return decision;
}

export async function invokeRouter(
  history: string[],
  candidates: string[],
): Promise<RouterDecision> {
  const config = getConfig();
  const formattedWindow = formatWindow(history, candidates);
  logger.info("Invoking router", { window: formattedWindow });

  try {
    const response = await getOllama().chat({
      model: config.router.model,
      messages: [
        {
          role: "system",
          content: config.router.systemPrompt,
        },
        {
          role: "user",
          content: formattedWindow + `${!config.router.think && "\n/no_think"}`,
        },
      ],
      options: config.router.options,
    });

    const raw = response.message.content.trim();
    logger.info("Router raw output:\n" + raw);

    return parseRouterOutput(raw);
  } catch (err) {
    logger.error("Router invocation failed — ignoring", {
      error: (err as Error).message,
    });
    return {
      type: "ignore",
      target: null,
      effort: null,
      title: null,
      reason: null,
    };
  }
}
