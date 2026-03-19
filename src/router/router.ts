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
  loadModel: (args: { modelPath: string }) => Promise<LoadedModel>;
};

type LoadedModel = {
  createContext: () => Promise<{
    getSequence: () => unknown;
    dispose?: () => Promise<void> | void;
  }>;
};

type LlamaChatSessionCtor = new (args: {
  contextSequence: unknown;
}) => {
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

let cachedLlama: LlamaRuntime | null = null;
let cachedModelPath: string | null = null;
let cachedModel: LoadedModel | null = null;
let LlamaChatSession: LlamaChatSessionCtor | null = null;
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

function parseModelfile(content: string, baseDir: string): LocalRouterOverrides {
  const lines = content.split(/\r?\n/);
  const parsed: LocalRouterOverrides = {
    parameters: {},
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i].trim();
    i += 1;

    if (!raw || raw.startsWith("#")) {
      continue;
    }

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
      parsed.systemPrompt = systemInline[1].trim().replace(/^['\"]|['\"]$/g, "");
      continue;
    }

    const parameterMatch = raw.match(/^PARAMETER\s+([A-Za-z0-9_.-]+)\s+(.+)$/i);
    if (parameterMatch?.[1] && parameterMatch[2]) {
      const key = parameterMatch[1].trim().toLowerCase();
      const value = parameterMatch[2].trim().replace(/^['\"]|['\"]$/g, "");

      if (key === "think") {
        parsed.think = !["false", "0", "no", "off"].includes(value.toLowerCase());
        continue;
      }

      const numeric = parseNumeric(value);
      if (numeric !== null) {
        parsed.parameters[key] = numeric;
      }
      continue;
    }
  }

  return parsed;
}

async function loadModelfileOverrides(modelfilePath: string): Promise<LocalRouterOverrides> {
  try {
    const stat = await (await import("node:fs/promises")).stat(modelfilePath);
    if (modelfileCachePath === modelfilePath && modelfileCacheMtimeMs === stat.mtimeMs) {
      return modelfileCache;
    }

    const content = await readFile(modelfilePath, "utf8");
    const parsed = parseModelfile(content, path.dirname(modelfilePath));

    modelfileCachePath = modelfilePath;
    modelfileCacheMtimeMs = stat.mtimeMs;
    modelfileCache = parsed;
    return parsed;
  } catch (err) {
    logger.warn("Router Modelfile could not be loaded; using runtime settings", {
      modelfilePath,
      error: (err as Error).message,
    });
    return { parameters: {} };
  }
}

async function resolveRouterModelPath(
  configuredModel: string | undefined,
  modelfileModelPath: string | undefined,
): Promise<string> {
  if (configuredModel && configuredModel.endsWith(".gguf")) {
    const explicit = path.isAbsolute(configuredModel)
      ? configuredModel
      : path.resolve(PROJECT_ROOT, configuredModel);
    if (await fileExists(explicit)) return explicit;
  }

  if (modelfileModelPath && (await fileExists(modelfileModelPath))) {
    return modelfileModelPath;
  }

  if (await fileExists(DEFAULT_MODEL_PATH)) {
    return DEFAULT_MODEL_PATH;
  }

  throw new Error(
    `Router GGUF model not found. Expected one of: ${DEFAULT_MODEL_PATH} or configured router.model`,
  );
}

async function getLoadedModel(modelPath: string): Promise<LoadedModel> {
  if (!cachedLlama || !LlamaChatSession) {
    const mod = (await import("node-llama-cpp")) as {
      getLlama: () => Promise<LlamaRuntime>;
      LlamaChatSession: LlamaChatSessionCtor;
    };
    cachedLlama = await mod.getLlama();
    LlamaChatSession = mod.LlamaChatSession;
  }

  if (cachedModel && cachedModelPath === modelPath) {
    return cachedModel;
  }

  cachedModel = await cachedLlama.loadModel({ modelPath });
  cachedModelPath = modelPath;
  logger.info("Router GGUF model loaded", { modelPath });
  return cachedModel;
}

function buildPrompt(systemPrompt: string, formattedWindow: string, think: boolean): string {
  const noThinkSuffix = think ? "" : "\n/no_think";
  return `${systemPrompt}\n\n${formattedWindow}${noThinkSuffix}`;
}

function buildGenerationOptions(
  runtimeOptions: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
  } | undefined,
  modelfileParameters: Record<string, number>,
): Record<string, number> {
  const merged = {
    temperature: runtimeOptions?.temperature,
    top_p: runtimeOptions?.top_p,
    top_k: runtimeOptions?.top_k,
    repeat_penalty: runtimeOptions?.repeat_penalty,
    ...modelfileParameters,
  };

  const out: Record<string, number> = {};
  if (typeof merged.temperature === "number") out.temperature = merged.temperature;
  if (typeof merged.top_p === "number") out.topP = merged.top_p;
  if (typeof merged.top_k === "number") out.topK = merged.top_k;
  if (typeof merged.repeat_penalty === "number") {
    out.repeatPenalty = merged.repeat_penalty;
  }
  if (typeof merged.repeat_penalty === "number") {
    out.repeatPenalty = merged.repeat_penalty;
  }

  return out;
}

export function formatWindow(history: string[], candidates: string[]): string {
  const h = [...history];
  while (h.length < 5) h.unshift("...");

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
              const slot = parseInt(slotMatch[1], 10);
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
    const configuredModelfilePath = process.env.ROUTER_MODELFILE_PATH
      ? path.resolve(PROJECT_ROOT, process.env.ROUTER_MODELFILE_PATH)
      : DEFAULT_MODELFILE_PATH;
    const modelfile = await loadModelfileOverrides(configuredModelfilePath);

    const modelPath = await resolveRouterModelPath(
      process.env.ROUTER_MODEL_PATH ?? config.router.model,
      modelfile.modelPath,
    );
    const loadedModel = await getLoadedModel(modelPath);
    const context = await loadedModel.createContext();
    const Session = LlamaChatSession;
    if (!Session) throw new Error("node-llama-cpp chat session is unavailable");

    const session = new Session({
      contextSequence: context.getSequence(),
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

    if (typeof context.dispose === "function") {
      await context.dispose();
    }

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
