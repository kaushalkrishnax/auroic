/**
 * Router — classifies history + candidate messages and returns a routing decision.
 * Architecture mirrors Ollama: warm session, prompt prefix caching, request queue.
 */

import { access, readFile, stat } from "node:fs/promises";
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

type LlamaChatSessionCtor = new (args: {
  contextSequence: unknown;
  systemPrompt?: string;
  autoDisposeSequence?: boolean;
}) => {
  prompt: (input: string, options?: Record<string, number>) => Promise<string>;
  resetChatHistory: () => void;
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

// Pre-compiled regexe─
const RE_THINK = /<think>\s*([\s\S]*?)\s*<\/think>/;
const RE_R_LINE = /R:\s*(.*)/;
const RE_KV = /([A-Z]+)\s*=\s*([^|\n,]+)/gi;
const RE_C_SLOT = /C(\d+)/i;
const RE_MENTION = /@\S+/g;
const RE_MENTION_KEEP_BOT = /@(?!BOT\b)\S+/gi;
const RE_SPACES = /\s{2,}/g;

// Singleton
let cachedLlama: LlamaRuntime | null = null;
let cachedModelPath: string | null = null;
let cachedModel: LoadedModel | null = null;
let cachedContext: LlamaContext | null = null;
let cachedSession: InstanceType<LlamaChatSessionCtor> | null = null;
let LlamaChatSession: LlamaChatSessionCtor | null = null;

// Tracks the system prompt the current session was built with.
let cachedSessionSystemPrompt: string | null = null;

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

// Modelfile cach
let modelfileCachePath: string | null = null;
let modelfileCacheMtimeMs = -1;
let modelfileCache: LocalRouterOverrides = { parameters: {} };

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
    i++;
    if (!raw || raw.startsWith("#")) continue;

    const fromMatch = raw.match(/^FROM\s+(.+)$/i);
    if (fromMatch?.[1]) {
      const v = fromMatch[1].trim().replace(/^['\"]|['\"]$/g, "");
      if (v.endsWith(".gguf")) {
        parsed.modelPath = path.isAbsolute(v) ? v : path.resolve(baseDir, v);
      }
      continue;
    }

    if (/^SYSTEM\s+"""\s*$/i.test(raw)) {
      const buf: string[] = [];
      while (i < lines.length && !/^"""\s*$/.test(lines[i].trim()))
        buf.push(lines[i++]);
      if (i < lines.length) i++;
      parsed.systemPrompt = buf.join("\n").trim();
      continue;
    }

    const sysInline = raw.match(/^SYSTEM\s+(.+)$/i);
    if (sysInline?.[1]) {
      parsed.systemPrompt = sysInline[1].trim().replace(/^['\"]|['\"]$/g, "");
      continue;
    }

    const paramMatch = raw.match(/^PARAMETER\s+([A-Za-z0-9_.-]+)\s+(.+)$/i);
    if (paramMatch?.[1] && paramMatch[2]) {
      const key = paramMatch[1].trim().toLowerCase();
      const value = paramMatch[2].trim().replace(/^['\"]|['\"]$/g, "");
      if (key === "think") {
        parsed.think = !["false", "0", "no", "off"].includes(
          value.toLowerCase(),
        );
        continue;
      }
      const numeric = parseNumeric(value);
      if (numeric !== null) parsed.parameters[key] = numeric;
    }
  }

  return parsed;
}

async function loadModelfileOverrides(
  modelfilePath: string,
): Promise<LocalRouterOverrides> {
  try {
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
      {
        modelfilePath,
        error: (err as Error).message,
      },
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
  if (modelfileModelPath && (await fileExists(modelfileModelPath)))
    return modelfileModelPath;
  if (await fileExists(DEFAULT_MODEL_PATH)) return DEFAULT_MODEL_PATH;
  throw new Error(
    `Router GGUF model not found. Expected: ${DEFAULT_MODEL_PATH}`,
  );
}

/**
 * Ollama-style warm session management.
 *
 * Layer 1 — llama runtime:    loaded once, never reloaded
 * Layer 2 — model weights:    reloaded only if modelPath changes
 * Layer 3 — KV context:       reloaded only if modelPath changes
 * Layer 4 — chat session:     rebuilt if systemPrompt changes, context is REUSED
 *
 * This means a system prompt hot-reload (e.g. Modelfile edit) only costs
 * a session rebuild, not a full model reload. Exactly what Ollama does.
 */
async function getSession(
  modelPath: string,
  systemPrompt: string,
  contextOpts: {
    threads: number;
    batchSize: number;
    contextSize: number;
    flashAttention: boolean;
  },
): Promise<InstanceType<LlamaChatSessionCtor>> {
  // Layer 1: bootstrap llama runtime onc
  if (!cachedLlama || !LlamaChatSession) {
    const mod = (await import("node-llama-cpp")) as {
      getLlama: (opts?: Record<string, unknown>) => Promise<LlamaRuntime>;
      LlamaChatSession: LlamaChatSessionCtor;
    };
    cachedLlama = await mod.getLlama();
    LlamaChatSession = mod.LlamaChatSession;
    logger.info("Router llama runtime initialized");
  }

  // Layer 2+3: rebuild model + context only on model path change
  if (cachedModelPath !== modelPath) {
    logger.info("Router model changed, reloading", { modelPath });

    if (cachedContext?.dispose) await cachedContext.dispose();
    cachedContext = null;
    cachedSession = null;
    cachedSessionSystemPrompt = null;

    cachedModel = await cachedLlama.loadModel({
      modelPath,
      defaultContextFlashAttention: contextOpts.flashAttention,
    });
    cachedModelPath = modelPath;

    cachedContext = await cachedModel.createContext({
      threads: contextOpts.threads,
      batchSize: contextOpts.batchSize,
      contextSize: contextOpts.contextSize,
      flashAttention: contextOpts.flashAttention,
    });

    logger.info("Router model + context loaded", { modelPath, contextOpts });
  }

  // Layer 4: rebuild session only if system prompt changed.
  if (!cachedSession || cachedSessionSystemPrompt !== systemPrompt) {
    cachedSession = new LlamaChatSession!({
      contextSequence: cachedContext!.getSequence(),
      systemPrompt, // baked into KV cache prefix
      autoDisposeSequence: false, // we manage context lifetime ourselves
    });
    cachedSessionSystemPrompt = systemPrompt;
    logger.info("Router session created with new system prompt");
  }

  return cachedSession;
}

function buildPrompt(formattedWindow: string, think: boolean): string {
  // System prompt is now passed to session constructor, NOT prepended here.
  // This lets node-llama-cpp cache the system prompt tokens in the KV cache.
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
    const configuredModelfilePath = process.env.ROUTER_MODELFILE_PATH
      ? path.resolve(PROJECT_ROOT, process.env.ROUTER_MODELFILE_PATH)
      : DEFAULT_MODELFILE_PATH;

    const [modelfile] = await Promise.all([
      loadModelfileOverrides(configuredModelfilePath),
    ]);

    const modelPath = await resolveRouterModelPath(
      process.env.ROUTER_MODEL_PATH ?? config.router.model,
      modelfile.modelPath,
    );

    const systemPrompt =
      modelfile.systemPrompt?.trim() || config.router.systemPrompt;
    const think = modelfile.think ?? config.router.think;

    const session = await getSession(modelPath, systemPrompt, {
      threads: 2,
      batchSize: 512,
      contextSize: 2048,
      flashAttention: true,
    });

    const prompt = buildPrompt(formattedWindow, think);
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
  } finally {
    releaseInfer();
  }
}
