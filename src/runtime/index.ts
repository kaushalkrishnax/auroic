/**
 * Centralised runtime configuration.
 *
 * Boot-time secrets come from .env (immutable after start).
 * Hot-reloadable tunables come from runtime.json — the file is watched
 * and reloaded automatically whenever it changes on disk.
 *
 * Call getConfig() anywhere; it always reflects the latest loaded values.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import logger from "@/utils/logger.js";
import { emitEvent } from "@/events.js";

// Runtime JSON path

const RUNTIME_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "runtime.json",
);

// Env (boot-time, immutable)

const env = {
  chromiumProfileDir:
    process.env.CHROMIUM_PROFILE_DIR ?? "./data/chrome-auroic",
  aiUrl: process.env.AI_API_URL ?? "https://api.openai.com/v1/chat/completions",
  aiKey: process.env.AI_API_KEY ?? "",
  igUsername: process.env.INSTAGRAM_USERNAME ?? "",
  igPassword: process.env.INSTAGRAM_PASSWORD ?? "",
  dbPath: process.env.DB_PATH ?? "./data/state.db",
};

// Runtime JSON

function loadRuntime(): RuntimeJson {
  const raw = fs.readFileSync(RUNTIME_PATH, "utf-8");
  return JSON.parse(raw) as RuntimeJson;
}

let runtime = loadRuntime();

// Internal write flag — suppresses fs.watch reload when we wrote the file ourselves
let _suppressNextReload = false;

// Bot identity — auto-detected and persisted to runtime.json so it survives restarts

export let BOT_FBID: string | null = runtime.instagram?.fbId ?? null;

export function setBotFbid(id: string): void {
  if (BOT_FBID === id) return;
  BOT_FBID = id;
  try {
    const updated = {
      ...runtime,
      instagram: { ...runtime.instagram, fbId: id },
    };
    _suppressNextReload = true;
    fs.writeFileSync(RUNTIME_PATH, JSON.stringify(updated, null, 2), "utf-8");
    runtime = loadRuntime();
  } catch (err) {
    logger.warn("Failed to persist bot fbId to runtime.json", {
      error: (err as Error).message,
    });
  }
}

// Config accessor

export function getConfig() {
  return {
    chromium: {
      profileDir: env.chromiumProfileDir,
    },
    instagram: {
      fbId: BOT_FBID,
      username: env.igUsername,
      password: env.igPassword,
      chatIds: (runtime.instagram?.chatIds ?? []).map(String),
    },
    triggers: runtime.triggers,
    llm: {
      url: env.aiUrl,
      key: env.aiKey,
      systemPrompt: runtime.llm.systemPrompt,
      timeout: runtime.llm.timeout,
      models: runtime.llm.models,
      translate: runtime.llm.translate,
      output: runtime.llm.output,
    },
    router: {
      host: runtime.router?.host ?? "http://localhost:11434",
      model: runtime.router?.model ?? "auroic-router-0.6b",
    },
    debug: {
      logRouterWindow: runtime.debug?.logRouterWindow ?? true,
    },
    db: { path: env.dbPath },
  };
}

export type Config = ReturnType<typeof getConfig>;

// Hot-reload

export function reloadRuntime(): boolean {
  try {
    runtime = loadRuntime();
    logger.info("runtime.json reloaded");
    emitEvent({ type: "CONFIG_CHANGED" });
    return true;
  } catch (err) {
    logger.error("Failed to reload runtime.json — keeping previous values", {
      error: (err as Error).message,
    });
    return false;
  }
}

export function watchRuntime(): void {
  fs.watch(RUNTIME_PATH, (eventType) => {
    if (eventType === "change") {
      if (_suppressNextReload) {
        _suppressNextReload = false;
        logger.info("Suppressed reload triggered by internal write");
        return;
      }
      logger.info("runtime.json changed — reloading…");
      reloadRuntime();
    }
  });
  logger.info("Watching runtime.json for changes", { path: RUNTIME_PATH });
}

export function getRuntimePath(): string {
  return RUNTIME_PATH;
}

export default getConfig;

// Runtime JSON shape

interface RuntimeJson {
  instagram?: {
    chatIds: (string | number)[];
    fbId?: string; // auto-detected; do not edit manually
  };
  triggers: {
    mentions: string[];
    hashtags: string[];
    keywords: string[];
    onReply: boolean;
  };
  llm: {
    systemPrompt: string;
    timeout: number;
    models: { low: string; medium: string; high: string };
    translate: { effort: "low" | "medium" | "high" | "auto" };
    output: { maxTokens: number };
  };
  router?: {
    host: string;
    model: string;
  };
  debug?: {
    logRouterWindow: boolean;
  };
}
