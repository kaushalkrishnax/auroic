/**
 * Centralised configuration
 * Runtime values → runtime.json
 * Secrets / boot config → .env
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import logger from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePath = path.join(process.cwd(), "src/config/runtime.json");

function loadRuntime() {
  const raw = fs.readFileSync(runtimePath, "utf-8");
  return JSON.parse(raw);
}

// Mutable runtime — replaced on reload
let runtime = loadRuntime();

// Boot-time env values (never change without restart)
const env = {
  chromiumProfileDir:
    process.env.CHROMIUM_PROFILE_DIR ?? "./data/chrome-auroic",
  aiUrl: process.env.AI_API_URL ?? "https://api.openai.com/v1/chat/completions",
  aiKey: process.env.AI_API_KEY ?? "",
  igUsername: process.env.INSTAGRAM_USERNAME ?? "",
  igPassword: process.env.INSTAGRAM_PASSWORD ?? "",
  dbPath: process.env.DB_PATH ?? "./data/state.db",
};

// Returns a fresh config snapshot — call this inside the loop instead of
// importing `config.X` at module load time
export function getConfig() {
  return {
    chromium: { profileDir: env.chromiumProfileDir },
    ai: {
      url: env.aiUrl,
      key: env.aiKey,
      model: runtime.ai.model,
      systemPrompt: runtime.ai.systemPrompt,
      timeout: runtime.ai.timeout,
    },
    instagram: {
      username: env.igUsername,
      password: env.igPassword,
      chatIds: (runtime.instagram?.chatIds ?? []).map(String),
    },
    triggers: runtime.triggers,
    poll: runtime.poll,
    typing: runtime.typing,
    rateLimit: runtime.rateLimit,
    history: runtime.history,
    batching: runtime.batching,
    cooldown: runtime.cooldown,
    output: runtime.output,
    retry: runtime.retry,
    log: runtime.log,
    db: { path: env.dbPath },
  };
}

export type Config = ReturnType<typeof getConfig>;

// Hot-reload: re-reads runtime.json, returns true if successful
export function reloadRuntime(): boolean {
  try {
    runtime = loadRuntime();
    logger.info("✅ runtime.json reloaded successfully");
    return true;
  } catch (err) {
    logger.error("❌ Failed to reload runtime.json — keeping previous values", {
      error: (err as Error).message,
    });
    return false;
  }
}

// Watch runtime.json and auto-reload when the UI saves it
export function watchRuntime(): void {
  fs.watch(runtimePath, (eventType) => {
    if (eventType === "change") {
      logger.info("🔄 runtime.json changed — reloading config…");
      reloadRuntime();
    }
  });
  logger.info("👁  Watching runtime.json for changes");
}

export default getConfig;
