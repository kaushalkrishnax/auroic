/**
 * Centralised configuration.
 *
 * Every tunable knob lives here so the rest of the codebase never
 * reads process.env directly.
 */

import "dotenv/config";

const env = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;
const int = (key: string, fallback: number): number =>
  parseInt(env(key, String(fallback)), 10);

const config = Object.freeze({
  // Chrome DevTools Protocol
  cdp: {
    url: env("CDP_URL", "http://localhost:9222"),
  },

  // AI API
  ai: {
    url: env("AI_API_URL", "https://api.openai.com/v1/chat/completions"),
    key: env("AI_API_KEY", ""),
    model: env("AI_API_MODEL", "gpt-4o"),
    systemPrompt: env(
      "AI_SYSTEM_PROMPT",
      "You are a helpful and concise AI assistant. Reply naturally and keep responses short and conversational.",
    ),
    timeout: int("AI_API_TIMEOUT", 30_000),
  },

  // Instagram
  instagram: {
    username: env("INSTAGRAM_USERNAME", ""),
    chatIds: env("CHAT_IDS", "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  },

  // Triggers
  triggers: {
    mentions: env("TRIGGER_MENTIONS", "auroic.ai")
      .split(",")
      .map((t) => {
        const val = t.trim().toLowerCase();
        return val && !val.startsWith("@") ? `@${val}` : val;
      })
      .filter(Boolean),
    hashtags: env("TRIGGER_HASHTAGS", "ai")
      .split(",")
      .map((t) => {
        const val = t.trim().toLowerCase();
        return val && !val.startsWith("#") ? `#${val}` : val;
      })
      .filter(Boolean),
    keywords: env("TRIGGER_KEYWORDS", "help,support")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
    onReply: env("TRIGGER_ON_REPLY", "true") === "true",
  },

  // Polling
  poll: {
    intervalMs: int("POLL_INTERVAL_MS", 10_000),
  },

  // Typing simulation
  typing: {
    minDelayMs: int("TYPING_MIN_DELAY_MS", 30),
    maxDelayMs: int("TYPING_MAX_DELAY_MS", 120),
    postResponseMs: int("TYPING_POST_RESPONSE_MS", 1_500),
  },

  // Rate limiting
  rateLimit: {
    maxRequestsPerMin: int("MAX_REQUESTS_PER_MIN", 30),
    maxTokensPerMin: int("MAX_TOKENS_PER_MIN", 60_000),
  },

  // Conversation history
  history: {
    maxMessages: int("MAX_HISTORY_MESSAGES", 10),
    maxTokens: int("MAX_HISTORY_TOKENS", 2_000),
  },

  // Message batching
  batching: {
    windowMs: int("BATCH_WINDOW_MS", 2_000),
  },

  // Per-user cooldown
  cooldown: {
    userCooldownMs: int("USER_COOLDOWN_MS", 5_000),
  },

  // Response token limit
  output: {
    maxTokens: int("MAX_OUTPUT_TOKENS", 300),
  },

  // Retry
  retry: {
    maxAttempts: int("MAX_RETRIES", 3),
    baseDelayMs: int("RETRY_BASE_DELAY_MS", 1_000),
  },

  // Database
  db: {
    path: env("DB_PATH", "./data/state.db"),
  },

  // Logging
  log: {
    level: env("LOG_LEVEL", "info"),
  },
});

export type Config = typeof config;
export default config;
