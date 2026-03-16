import "dotenv/config";
import logger from "@/utils/logger.js";
import { emitEvent } from "@/events.js";
import { initConfigDB } from "@/db/configDb.js";
import {
  DEFAULT_RUNTIME_SETTINGS,
  ensureConfigSeeded,
  getCommandConfigs,
  getSettingsPayload,
  type CommandConfigRow,
  type RuntimeSettingsPayload,
} from "@/db/queries/config.js";

const env = {
  chromiumProfileDir: process.env.CHROMIUM_PROFILE_DIR ?? "./data/chrome-auroic",
  aiUrl: process.env.AI_API_URL ?? "https://api.openai.com/v1/chat/completions",
  igChatIds: (process.env.INSTAGRAM_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
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
  initConfigDB(env.configDbPath);
  ensureConfigSeeded();
  reloadConfig();
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
  const commands = runtimeSettings.commands;

  const queryFilterWords = Array.isArray(commands.queryFilterWords)
    ? commands.queryFilterWords.map((v) => String(v).toLowerCase())
    : ["gif", "gifs", "sticker", "stickers", "media", "meme", "memes", "image", "images"];

  return {
    chromium: {
      profileDir: env.chromiumProfileDir,
    },
    instagram: {
      ...(runtimeSettings.instagram as Record<string, unknown>),
      fbId: BOT_FBID,
      username: env.igUsername,
      password: env.igPassword,
      chatIds: env.igChatIds,
    },
    triggers: runtimeSettings.triggers,
    llm: {
      url: env.aiUrl,
      key: env.aiKey,
      systemPrompt: llm.systemPrompt,
      timeout: llm.timeout,
      models: llm.models ?? {
        low: "llama-3.1-8b-instant",
        medium: "meta-llama/llama-4-scout-17b-16e-instruct",
        high: "openai/gpt-oss-120b",
      },
      output: llm.output ?? { maxTokens: 100 },
    },
    router: {
      host: router.host ?? "http://localhost:11434",
      model: router.model ?? "auroic-router-0.6b",
      systemPrompt:
        router.systemPrompt ??
        "You are the Auroic Router. Given history messages H1-H5 and candidate messages C1-C3, output exactly one routing decision.",
      think: router.think ?? true,
      options: router.options ?? {
        temperature: 0.5,
        top_p: 1.05,
        top_k: 20,
        repeat_penalty: 1.1,
      },
    },
    commands: {
      enabled: Boolean(commands.enabled ?? true),
      queryFilterWords,
      rows: commandRows,
      filterWords: Object.fromEntries(
        commandRows.map((row) => [row.command, row.filterKeywords]),
      ),
    },
    debug: {
      logRouterWindow: runtimeSettings.debug.logRouterWindow ?? true,
    },
    db: { path: env.dbPath },
    configDb: { path: env.configDbPath },
  };
}

export type Config = ReturnType<typeof getConfig>;

export default getConfig;
