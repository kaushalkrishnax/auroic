/**
 * Router — classifies history + candidate messages and returns a routing decision.
 * Uses Ollama generate API with a serialized request queue.
 */

import { Ollama } from "ollama";
import getConfig from "@/runtime/index.js";
import logger from "@/utils/logger.js";
import type { RouterDecision, ActionType, EffortLevel } from "@/types/index.js";

// Pre-compiled regexes
const RE_THINK = /<think>\s*([\s\S]*?)\s*<\/think>/;
const RE_R_LINE = /R:\s*(.*)/;
const RE_KV = /([A-Z]+)\s*=\s*([^|\n,]+)/gi;
const RE_C_SLOT = /C(\d+)/i;
const RE_MENTION = /@\S+/g;
const RE_MENTION_KEEP_BOT = /@(?!BOT\b)\S+/gi;
const RE_SPACES = /\s{2,}/g;

const ollamaClients = new Map<string, Ollama>();

interface RouterGenerateResponse {
  response?: string;
  error?: string;
}

function normalizeRouterHost(rawHost: string): string {
  const trimmed = rawHost.trim();
  if (!trimmed) return "http://127.0.0.1:11434";

  const noTrailing = trimmed.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(noTrailing)) return noTrailing;

  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(noTrailing)) {
    return `http://${noTrailing}`;
  }

  return `https://${noTrailing}`;
}

function buildGenerateEndpoints(host: string): string[] {
  const normalized = normalizeRouterHost(host);
  const lower = normalized.toLowerCase();

  if (lower.endsWith("/api/generate")) {
    return [normalized];
  }

  return [`${normalized}/api/generate`, `${normalized}/ollama/api/generate`];
}

async function generateViaHttpFallback(
  endpoints: string[],
  payload: {
    model: string;
    prompt: string;
    system: string;
    options: Record<string, number>;
  },
): Promise<string> {
  const failures: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          stream: false,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        failures.push(`${endpoint} -> HTTP ${res.status}: ${body}`);
        continue;
      }

      const data = (await res.json()) as RouterGenerateResponse;
      if (typeof data.response !== "string") {
        failures.push(
          `${endpoint} -> ${data.error ?? "Missing response in payload"}`,
        );
        continue;
      }

      return data.response.trim();
    } catch (err) {
      const error = err as Error;
      failures.push(`${endpoint} -> ${error.message}`);
    }
  }

  throw new Error(failures.join(" | "));
}

function getOllamaClient(host: string): Ollama {
  const normalizedHost = normalizeRouterHost(host);
  const cached = ollamaClients.get(normalizedHost);
  if (cached) return cached;

  const client = new Ollama({ host: normalizedHost });
  ollamaClients.set(normalizedHost, client);
  return client;
}

// Request queue — mirrors Ollama's serial inference queu
let _inferRunning = false;
const _inferQueue: Array<() => void> = [];

function acquireInfer(): Promise<void> {
  return new Promise((resolve) => {
    if (!_inferRunning) {
      _inferRunning = true;
      resolve();
    } else {
      _inferQueue.push(resolve);
    }
  });
}

function releaseInfer(): void {
  const next = _inferQueue.shift();
  if (next) {
    next();
  } else {
    _inferRunning = false;
  }
}

function buildPrompt(formattedWindow: string, think: boolean): string {
  return think ? formattedWindow : `${formattedWindow}\n/no_think`;
}

function buildGenerationOptions(
  runtimeOptions:
    | {
        temperature?: number;
        top_p?: number;
        top_k?: number;
        repeat_penalty?: number;
      }
    | undefined,
  modelfileParameters: Record<string, number>,
): Record<string, number> {
  const merged = {
    temperature: runtimeOptions?.temperature,
    top_p: runtimeOptions?.top_p,
    top_k: runtimeOptions?.top_k,
    repeat_penalty: runtimeOptions?.repeat_penalty,
    ...modelfileParameters, // modelfile wins
  };

  const out: Record<string, number> = {};
  if (typeof merged.temperature === "number")
    out.temperature = merged.temperature;
  if (typeof merged.top_p === "number") out.topP = merged.top_p;
  if (typeof merged.top_k === "number") out.topK = merged.top_k;
  if (typeof merged.repeat_penalty === "number")
    out.repeatPenalty = merged.repeat_penalty;
  return out;
}

export function formatWindow(history: string[], candidates: string[]): string {
  const h = [...history];
  while (h.length < 5) h.unshift("...");

  const c = [...candidates];
  while (c.length < 3) c.unshift("...");

  // Trim long messages — prevents context overflow on chatty groups
  const trim = (s: string) => (s.length > 200 ? s.slice(0, 197) + "..." : s);

  return [
    ...h.map((msg, i) => `H${i + 1}: ${stripMentions(trim(msg))}`),
    ...c.map((msg, i) => `C${i + 1}: ${stripMentions(trim(msg), true)}`),
  ].join("\n");
}

function stripMentions(text: string, keepBot = false): string {
  return text
    .replace(keepBot ? RE_MENTION_KEEP_BOT : RE_MENTION, "")
    .replace(RE_SPACES, " ")
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
    const thinkMatch = output.match(RE_THINK);
    if (thinkMatch?.[1]) decision.reason = thinkMatch[1].trim();

    const rMatch = output.match(RE_R_LINE);
    const parsePart = rMatch ? rMatch[1] : output;

    // Reset lastIndex before exec loop — shared regex requires this
    RE_KV.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = RE_KV.exec(parsePart)) !== null) {
      const key = match[1].trim().toUpperCase();
      const value = match[2].trim();
      if (!key || !value) continue;
      const lower = value.toLowerCase();

      switch (key) {
        case "TYPE":
          if (["text", "ignore", "react", "media"].includes(lower))
            decision.type = lower as ActionType;
          break;
        case "TARGET":
          if (lower === "null") {
            decision.target = null;
          } else {
            const slotMatch = value.match(RE_C_SLOT);
            decision.target = slotMatch
              ? `C${parseInt(slotMatch[1], 10)}`
              : value;
          }
          break;
        case "EFFORT":
          if (["low", "medium", "high"].includes(lower))
            decision.effort = lower as EffortLevel;
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

  // Serialize inference — same as Ollama's request queue
  await acquireInfer();

  try {
    const host = config.router.hostUrl;
    const model = config.router.model;
    const systemPrompt = config.router.systemPrompt;
    const think = config.router.think;
    const ollama = getOllamaClient(host);

    const prompt = buildPrompt(formattedWindow, think);
    const generationOptions = buildGenerationOptions(config.router.options, {});

    let raw: string;
    try {
      const response = await ollama.generate({
        model,
        prompt,
        system: systemPrompt,
        options: generationOptions,
        stream: false,
      });
      raw = response.response.trim();
    } catch (sdkErr) {
      logger.warn("Router SDK call failed, trying direct HTTP fallback", {
        host: normalizeRouterHost(host),
        model,
        error: (sdkErr as Error).message,
      });

      raw = await generateViaHttpFallback(buildGenerateEndpoints(host), {
        model,
        prompt,
        system: systemPrompt,
        options: generationOptions,
      });
    }

    logger.info("Router raw output:\n" + raw);

    return parseRouterOutput(raw);
  } catch (err) {
    const error = err as Error & {
      cause?: {
        code?: string;
        message?: string;
      };
    };

    logger.error("Router invocation failed — ignoring", {
      host: config.router.hostUrl,
      model: config.router.model,
      error: error.message,
      causeCode: error.cause?.code ?? null,
      causeMessage: error.cause?.message ?? null,
    });
    return {
      type: "ignore",
      target: null,
      effort: null,
      title: null,
      reason: null,
    };
  } finally {
    releaseInfer();
  }
}
