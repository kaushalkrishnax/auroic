/**
 * Router — classifies history + candidate messages and returns a routing decision.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import getConfig from "@/runtime/index.js";
import logger from "@/utils/logger.js";
import type { RouterDecision, ActionType, EffortLevel } from "@/types/index.js";

interface LocalRouterOverrides {
  systemPrompt?: string;
  think?: boolean;
  parameters: Record<string, number>;
  modelPath?: string;
}

type LlamaRuntime = {
  loadModel: (args: {
    modelPath: string;
    defaultContextFlashAttention?: boolean;
  }) => Promise<LoadedModel>;
};

type LoadedModel = {
  createContext: (opts?: {
    threads?: number;
    batchSize?: number;
    contextSize?: number;
    flashAttention?: boolean;
  }) => Promise<LlamaContext>;
};

type LlamaContext = {
  getSequence: () => unknown;
  dispose?: () => Promise<void> | void;
};

type LlamaChatSessionCtor = new (args: { contextSequence: unknown }) => {
  prompt: (input: string, options?: Record<string, number>) => Promise<string>;
};

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DEFAULT_MODEL_DIR = path.join(PROJECT_ROOT, "models", "auroic-router");
const DEFAULT_MODEL_PATH = path.join(
  DEFAULT_MODEL_DIR,
  "auroic-router-0.6b.gguf",
);
const DEFAULT_MODELFILE_PATH = path.join(DEFAULT_MODEL_DIR, "Modelfile");

// ── Singletons ────────────────────────────────────────────────────────────────
// Model is cached across calls (already done)
// Context + Session are NOW also cached — this is the biggest perf fix.
// Previously a fresh context was created and disposed on every single call.
let cachedLlama: LlamaRuntime | null = null;
let cachedModelPath: string | null = null;
let cachedModel: LoadedModel | null = null;
let cachedContext: LlamaContext | null = null;
let cachedSession: InstanceType<LlamaChatSessionCtor> | null = null;
let LlamaChatSession: LlamaChatSessionCtor | null = null;

// ── Modelfile cache ───────────────────────────────────────────────────────────
let modelfileCachePath: string | null = null;
let modelfileCacheMtimeMs = -1;
let modelfileCache: LocalRouterOverrides = { parameters: {} };

// ── Duplicate repeat_penalty bug fix ─────────────────────────────────────────
// Original code set repeatPenalty twice. Fixed below in buildGenerationOptions.

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseNumeric(value: string): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseModelfile(
  content: string,
  baseDir: string,
): LocalRouterOverrides {
  const lines = content.split(/\r?\n/);
  const parsed: LocalRouterOverrides = { parameters: {} };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i].trim();
    i += 1;

    if (!raw || raw.startsWith("#")) continue;

    const fromMatch = raw.match(/^FROM\s+(.+)$/i);
    if (fromMatch?.[1]) {
      const fromValue = fromMatch[1].trim().replace(/^['\"]|['\"]$/g, "");
      if (fromValue.endsWith(".gguf")) {
        parsed.modelPath = path.isAbsolute(fromValue)
          ? fromValue
          : path.resolve(baseDir, fromValue);
      }
      continue;
    }

    if (/^SYSTEM\s+"""\s*$/i.test(raw)) {
      const buffer: string[] = [];
      while (i < lines.length && !/^"""\s*$/.test(lines[i].trim())) {
        buffer.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      parsed.systemPrompt = buffer.join("\n").trim();
      continue;
    }

    const systemInline = raw.match(/^SYSTEM\s+(.+)$/i);
    if (systemInline?.[1]) {
      parsed.systemPrompt = systemInline[1]
        .trim()
        .replace(/^['\"]|['\"]$/g, "");
      continue;
    }

    const parameterMatch = raw.match(/^PARAMETER\s+([A-Za-z0-9_.-]+)\s+(.+)$/i);
    if (parameterMatch?.[1] && parameterMatch[2]) {
      const key = parameterMatch[1].trim().toLowerCase();
      const value = parameterMatch[2].trim().replace(/^['\"]|['\"]$/g, "");

      if (key === "think") {
        parsed.think = !["false", "0", "no", "off"].includes(
          value.toLowerCase(),
        );
        continue;
      }

      const numeric = parseNumeric(value);
      if (numeric !== null) parsed.parameters[key] = numeric;
      continue;
    }
  }

  return parsed;
}

async function loadModelfileOverrides(
  modelfilePath: string,
): Promise<LocalRouterOverrides> {
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(modelfilePath);

    if (
      modelfileCachePath === modelfilePath &&
      modelfileCacheMtimeMs === s.mtimeMs
    ) {
      return modelfileCache;
    }

    const content = await readFile(modelfilePath, "utf8");
    const parsed = parseModelfile(content, path.dirname(modelfilePath));

    modelfileCachePath = modelfilePath;
    modelfileCacheMtimeMs = s.mtimeMs;
    modelfileCache = parsed;
    return parsed;
  } catch (err) {
    logger.warn(
      "Router Modelfile could not be loaded; using runtime settings",
      { modelfilePath, error: (err as Error).message },
    );
    return { parameters: {} };
  }
}

async function resolveRouterModelPath(
  configuredModel: string | undefined,
  modelfileModelPath: string | undefined,
): Promise<string> {
  if (configuredModel?.endsWith(".gguf")) {
    const explicit = path.isAbsolute(configuredModel)
      ? configuredModel
      : path.resolve(PROJECT_ROOT, configuredModel);
    if (await fileExists(explicit)) return explicit;
  }

  if (modelfileModelPath && (await fileExists(modelfileModelPath))) {
    return modelfileModelPath;
  }

  if (await fileExists(DEFAULT_MODEL_PATH)) return DEFAULT_MODEL_PATH;

  throw new Error(
    `Router GGUF model not found. Expected: ${DEFAULT_MODEL_PATH} or configured router.model`,
  );
}

/**
 * Returns a warm, reusable session.
 * Creates everything once; subsequent calls return the cached session instantly.
 * If the model path changes (hot-swap), everything is rebuilt.
 */
async function getSession(
  modelPath: string,
  contextOpts: {
    threads: number;
    batchSize: number;
    contextSize: number;
    flashAttention: boolean;
  },
): Promise<InstanceType<LlamaChatSessionCtor>> {
  // Bootstrap llama runtime once
  if (!cachedLlama || !LlamaChatSession) {
    const mod = (await import("node-llama-cpp")) as {
      getLlama: (opts?: Record<string, unknown>) => Promise<LlamaRuntime>;
      LlamaChatSession: LlamaChatSessionCtor;
    };
    cachedLlama = await mod.getLlama();
    LlamaChatSession = mod.LlamaChatSession;
  }

  // Rebuild everything if model path changed
  if (cachedModelPath !== modelPath) {
    logger.info("Router model path changed, rebuilding context", { modelPath });

    if (cachedContext?.dispose) await cachedContext.dispose();
    cachedContext = null;
    cachedSession = null;

    cachedModel = await cachedLlama.loadModel({
      modelPath,
      defaultContextFlashAttention: contextOpts.flashAttention,
    });
    cachedModelPath = modelPath;
    logger.info("Router GGUF model loaded", { modelPath });
  }

  // Reuse existing warm session
  if (cachedSession && cachedContext) {
    return cachedSession;
  }

  // Create context + session once
  cachedContext = await cachedModel!.createContext({
    threads: contextOpts.threads,
    batchSize: contextOpts.batchSize,
    contextSize: contextOpts.contextSize,
    flashAttention: contextOpts.flashAttention,
  });

  cachedSession = new LlamaChatSession!({
    contextSequence: cachedContext.getSequence(),
  });

  logger.info("Router context + session created", { contextOpts });
  return cachedSession;
}

function buildPrompt(
  systemPrompt: string,
  formattedWindow: string,
  think: boolean,
): string {
  const noThinkSuffix = think ? "" : "\n/no_think";
  return `${systemPrompt}\n\n${formattedWindow}${noThinkSuffix}`;
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
  // Modelfile params win over runtime options
  const merged = {
    temperature: runtimeOptions?.temperature,
    top_p: runtimeOptions?.top_p,
    top_k: runtimeOptions?.top_k,
    repeat_penalty: runtimeOptions?.repeat_penalty,
    ...modelfileParameters,
  };

  const out: Record<string, number> = {};
  if (typeof merged.temperature === "number")
    out.temperature = merged.temperature;
  if (typeof merged.top_p === "number") out.topP = merged.top_p;
  if (typeof merged.top_k === "number") out.topK = merged.top_k;
  if (typeof merged.repeat_penalty === "number")
    out.repeatPenalty = merged.repeat_penalty; // fixed: was set twice
  return out;
}

export function formatWindow(history: string[], candidates: string[]): string {
  const h = [...history];
  while (h.length < 5) h.unshift("...");

  const c = [...candidates];
  while (c.length < 3) c.unshift("...");

  return [
    ...h.map((msg, i) => `H${i + 1}: ${stripMentions(msg)}`),
    ...c.map((msg, i) => `C${i + 1}: ${stripMentions(msg, true)}`),
  ].join("\n");
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
    if (thinkMatch?.[1]) decision.reason = thinkMatch[1].trim();

    const rMatch = output.match(/R:\s*(.*)/);
    const parsePart = rMatch ? rMatch[1] : output;
    const regex = /([A-Z]+)\s*=\s*([^|\n,]+)/gi;
    let match: RegExpExecArray | null;

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
        case "TARGET":
          if (lower === "null") {
            decision.target = null;
          } else {
            const slotMatch = value.match(/C(\d+)/i);
            decision.target = slotMatch
              ? `C${parseInt(slotMatch[1], 10)}`
              : value;
          }
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

export async function invokeRouter(
  history: string[],
  candidates: string[],
): Promise<RouterDecision> {
  const config = getConfig();
  const formattedWindow = formatWindow(history, candidates);
  logger.info("Invoking router", { window: formattedWindow });

  try {
    const configuredModelfilePath = process.env.ROUTER_MODELFILE_PATH
      ? path.resolve(PROJECT_ROOT, process.env.ROUTER_MODELFILE_PATH)
      : DEFAULT_MODELFILE_PATH;

    const modelfile = await loadModelfileOverrides(configuredModelfilePath);

    const modelPath = await resolveRouterModelPath(
      process.env.ROUTER_MODEL_PATH ?? config.router.model,
      modelfile.modelPath,
    );

    // Get warm session — no cold start after first call
    const session = await getSession(modelPath, {
      threads: 2, // use both cores on your i3
      batchSize: 512,
      contextSize: 512, // router output is tiny, no need for 4096
      flashAttention: true, // helps even on CPU in recent llama.cpp builds
    });

    const prompt = buildPrompt(
      modelfile.systemPrompt?.trim() || config.router.systemPrompt,
      formattedWindow,
      modelfile.think ?? config.router.think,
    );

    const generationOptions = buildGenerationOptions(
      config.router.options,
      modelfile.parameters,
    );

    const raw = (await session.prompt(prompt, generationOptions)).trim();
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
