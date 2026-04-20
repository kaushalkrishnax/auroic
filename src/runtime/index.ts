import "dotenv/config";
import logger from "@/utils/logger.js";
import { emitEvent } from "@/events.js";
import { initConfigDB } from "@/db/configDb.js";
import {
  DEFAULT_RUNTIME_SETTINGS,
  ensureConfigSeeded,
  syncCommandsWithRegistry,
  getCommandConfigs,
  getSettingsPayload,
  type CommandConfigRow,
  type RuntimeSettingsPayload,
} from "@/db/queries/config.js";

const env = {
  chromiumProfileDir:
    process.env.CHROMIUM_PROFILE_DIR ?? "./data/chrome-auroic",
  aiUrl: process.env.AI_API_URL ?? "https://api.openai.com/v1/chat/completions",
  aiKey: process.env.AI_API_KEY ?? "",
  igUsername: process.env.INSTAGRAM_USERNAME ?? "",
  igPassword: process.env.INSTAGRAM_PASSWORD ?? "",
  dbPath: process.env.DB_PATH ?? "./data/state.db",
  configDbPath: process.env.CONFIG_DB_PATH ?? "./data/config.db",
};

let runtimeSettings: RuntimeSettingsPayload = DEFAULT_RUNTIME_SETTINGS;

let commandRows: CommandConfigRow[] = [];

export let BOT_FBID: string | null = null;

export function setBotFbid(id: string): void {
  if (BOT_FBID === id) return;
  BOT_FBID = id;
  logger.info("Bot fbId auto-detected", { fbId: id });
}

export function initRuntimeConfig(): void {
  try {
    initConfigDB(env.configDbPath);
    ensureConfigSeeded();
    syncCommandsWithRegistry();
    if (!reloadConfig()) {
      throw new Error("Failed to load runtime config");
    }
  } catch (err) {
    logger.error("Fatal error during config initialization", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    throw err;
  }
}

export function reloadConfig(): boolean {
  try {
    runtimeSettings = getSettingsPayload();
    commandRows = getCommandConfigs();
    logger.info("Runtime config reloaded from config.db", {
      commandCount: commandRows.length,
    });
    emitEvent({ type: "CONFIG_CHANGED" });
    return true;
  } catch (err) {
    logger.error("Failed to reload runtime config from config.db", {
      error: (err as Error).message,
    });
    return false;
  }
}

export function getConfig() {
  const llm = runtimeSettings.llm;
  const router = runtimeSettings.router;
  const tts = runtimeSettings.tts;
  const igSettings = (runtimeSettings.instagram ?? {}) as Record<
    string,
    unknown
  >;
  const igChatIds = Array.isArray(igSettings.chatIds)
    ? igSettings.chatIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

  return {
    chromium: {
      profileDir: env.chromiumProfileDir,
    },
    instagram: {
      ...igSettings,
      fbId: BOT_FBID,
      username: env.igUsername,
      password: env.igPassword,
      chatIds: igChatIds,
    },
    triggers: runtimeSettings.triggers,
    llm: {
      url: env.aiUrl,
      key: env.aiKey,
      systemPrompt: llm.systemPrompt,
      models: llm.models ?? {
        low: "llama-3.1-8b-instant",
        medium: "meta-llama/llama-4-scout-17b-16e-instruct",
        high: "openai/gpt-oss-120b",
      },
      output: llm.output ?? {
        maxTokens: 100,
        timeout: 30000,
      },
    },
    router: {
      hostUrl: router.hostUrl ?? "http://127.0.0.1:11434",
      model: router.model ?? "auroic-router:latest",
      think: router.think ?? true,
      systemPrompt:
        router.systemPrompt ??
        "You are the Auroic Router. Given history messages H1-H5 and candidate messages C1-C3, output exactly one routing decision.",
      options: router.options ?? {
        temperature: 0.5,
        top_p: 1.05,
        top_k: 20,
        repeat_penalty: 1.1,
      },
    },
    debug: {
      logRouterWindow: runtimeSettings.debug.logRouterWindow ?? true,
    },
    tts: {
      voice:
        typeof tts?.voice === "string" && tts.voice.trim()
          ? tts.voice.trim()
          : "hf_alpha",
    },
    db: { path: env.dbPath },
    configDb: { path: env.configDbPath },
  };
}

export function getCommandRows(): CommandConfigRow[] {
  return commandRows;
}

export type Config = ReturnType<typeof getConfig>;

export default getConfig;
