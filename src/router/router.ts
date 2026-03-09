/**
 * Router — classifies a 5-message window and returns a routing decision.
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

export function formatWindow(window: string[]): string {
  return window.map((msg, i) => `M${i + 1}: ${msg}`).join("\n");
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
          if (
            [
              "text",
              "ignore",
              "acknowledge",
              "react",
              "media",
              "translate",
              "command",
            ].includes(lower)
          ) {
            decision.type = lower as ActionType;
          }
          break;
        case "TARGET":
          decision.target = lower === "null" ? null : value;
          break;
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

export async function invokeRouter(window: string[]): Promise<RouterDecision> {
  const config = getConfig();
  const formattedWindow = formatWindow(window);
  logger.info("Invoking router", { window: formattedWindow });

  try {
    const response = await getOllama().chat({
      model: config.router.model,
      messages: [{ role: "user", content: formattedWindow }],
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
