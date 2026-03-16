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
  igChatIds: (process.env.INSTAGRAM_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
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

// Bot identity — auto-detected from the Instagram mailbox GraphQL response on first boot.

export let BOT_FBID: string | null = null;

export function setBotFbid(id: string): void {
  if (BOT_FBID === id) return;
  BOT_FBID = id;
  logger.info("Bot fbId auto-detected", { fbId: id });
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
      chatIds: env.igChatIds,
    },
    triggers: runtime.triggers,
    llm: {
      url: env.aiUrl,
      key: env.aiKey,
      systemPrompt: runtime.llm.systemPrompt,
      timeout: runtime.llm.timeout,
      models: runtime.llm.models,
      output: runtime.llm.output,
    },
    router: {
      host: runtime.router?.host ?? "http://localhost:11434",
      model: runtime.router?.model ?? "auroic-router-0.6b",
      systemPrompt:
        runtime.router?.systemPrompt ??
        "You are the Auroic Router. Given history messages H1-H5 and candidate messages C1-C3, output exactly one routing decision.",
      think: runtime.router?.think ?? true,
      options: {
        temperature: runtime.router?.options?.temperature ?? 0.6,
        top_p: runtime.router?.options?.top_p ?? 0.95,
        top_k: runtime.router?.options?.top_k ?? 20,
        repeat_penalty: runtime.router?.options?.repeat_penalty ?? 1.1,
      },
    },
    commands: {
      enabled: runtime.commands?.enabled ?? false,
      similarityThreshold: runtime.commands?.similarityThreshold ?? 0.8,
      filterWords: runtime.commands?.filterWords ?? {},
      queryFilterWords: runtime.commands?.queryFilterWords ?? [
        "gif",
        "gifs",
        "sticker",
        "stickers",
        "media",
        "meme",
        "memes",
        "image",
        "images",
      ],
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
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  fs.watch(RUNTIME_PATH, (eventType) => {
    if (eventType === "change") {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        logger.info("runtime.json changed — reloading…");
        reloadRuntime();
      }, 150);
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
  triggers: {
    mentions: string[];
    hashtags: string[];
    keywords?: string[];
    onReply?: boolean;
    passiveMonitoring?: {
      enabled: boolean;
      messageCount: number;
      timeThresholdMs: number;
      cooldownMs?: number;
    };
  };
  llm: {
    systemPrompt: string;
    timeout: number;
    models: { low: string; medium: string; high: string };
    output: { maxTokens: number };
  };
  router?: {
    host: string;
    model: string;
    systemPrompt?: string;
    think?: boolean;
    options?: {
      temperature?: number;
      top_p?: number;
      top_k?: number;
      repeat_penalty?: number;
    };
  };
  commands?: {
    enabled?: boolean;
    similarityThreshold?: number;
    queryFilterWords?: string[];
    filterWords?: Record<string, string[]>;
  };
  debug?: {
    logRouterWindow: boolean;
  };
}
