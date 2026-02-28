# Auroic — Instagram AI Assistant

> **⚠️ Beta Version** — This project is under active development. Features may change, and some edge cases are still being refined.

---

### 🤖 Foundation with Claude Opus 4.6

**Auroic** is fundamentally built with **Claude Opus 4.6 (Anthropic)** under the direction of a single developer — **[Kaushal Krishna](https://github.com/kaushalkrishnax)**. The project evolved through iterative conversations, where the developer defined goals, reviewed outputs, and refined the system step by step, resulting in a fully engineered product guided by human decisions and AI execution.

---

## What is Auroic?

Auroic is a local-first Instagram AI assistant that connects to your already logged-in Chrome browser via the Chrome DevTools Protocol (CDP). It monitors Instagram DM conversations, detects configurable triggers, and generates AI-powered replies through any OpenAI-compatible API. The entire system runs on your machine — no cloud services, no login automation, no stored credentials.

Designed for personal or small-group automation with full control over behaviour and limits.

---

## Features

### Core

- **Multi-chat monitoring** — One dedicated browser tab per conversation. No page reloading, no navigation between chats. Tabs are opened once on startup and monitored in parallel.
- **Configurable trigger system** — Mention triggers, hashtag triggers, keyword triggers, and reply detection — all defined in `.env`. Add as many as you want, comma-separated.
- **OpenAI-compatible API** — Works with Groq, OpenAI, Ollama, LM Studio, or any endpoint that follows the OpenAI chat completions spec.
- **Native chat history** — Recent messages are sent as native `messages[]` array entries, not crammed into a single prompt string. History is trimmed by both message count and token budget.

### Rate Limiting & Safety

- **Central request queue** — Sliding-window rate limiter enforcing `MAX_REQUESTS_PER_MIN` and `MAX_TOKENS_PER_MIN`. Requests are queued, never dropped.
- **Token estimation & budgeting** — Tokens are estimated before each request. If the budget is exhausted, the request waits for the next window.
- **Per-user cooldown** — Prevents rapid-fire AI calls from the same user within `USER_COOLDOWN_MS`.
- **Priority queue** — Mentions and triggers get higher priority but still respect global limits.
- **Response token cap** — `MAX_OUTPUT_TOKENS` controls the maximum response length.

### Human-Like Behaviour

- **Typing simulation** — The bot starts "typing" the moment the AI request fires. It types random characters, pauses, deletes, and thinks — mimicking a real person. After the reply arrives, typing continues for a realistic duration before the actual message is sent.
- **Random delays** — Inter-chat delays, pre-send pauses, and poll intervals are all randomised within configurable ranges.

### Reliability

- **Automatic reconnection** — If Chrome disconnects, the bot reconnects on the next poll cycle. Dead tabs are automatically re-opened.
- **Retry with backoff** — Failed API calls are retried with exponential backoff. HTTP 429 and 503 responses use the `Retry-After` header when available.
- **Deduplication** — SQLite-backed message fingerprinting prevents duplicate replies. Fingerprints include sender username, message text, and message count.
- **Graceful shutdown** — SIGINT/SIGTERM handlers cleanly close the database and detach from the browser.

### Sender Tracking

- **Per-message username extraction** — The sender of each message is identified from Instagram's DOM (avatar link `href`). The bot never confuses its own messages with user messages.
- **Bot message filtering** — The bot's own messages are excluded from history context and never trigger a response loop.

### Observability

- **Structured logging** — Winston-based JSON logs with configurable log level.
- **Rate limiter metrics** — Queue size, requests/min, and tokens/min are logged periodically.

---

## Quick Start

### Prerequisites

| Requirement   | Version           |
| ------------- | ----------------- |
| Node.js       | ≥ 20 LTS          |
| Google Chrome | Latest stable     |
| Docker        | ≥ 24 _(optional)_ |

## Configuration

```bash
cp .env.example .env
```

Boot configuration is done through environment variables. See [`.env.example`](.env.example).

## Deployment

### Docker (recommended)

```bash
docker build -t auroic .
docker run -d \
  --name auroic \
  --network=host \
  --env-file .env \
  auroic
```

### npm

```bash
npm install
npm run build
node dist/index.js
```

Both methods are fully supported. The `dev` script uses `--watch` for auto-restart on code changes.

---

## Error Handling

- **Selector failures** — Caught and logged; the chat is skipped for that cycle.
- **Network failures** — Retried with exponential backoff.
- **Browser disconnect** — Auto-reconnects on the next poll cycle, re-opens dead tabs.
- **AI API failures** — Retried; if still failing, the conversation is skipped (never crashes).
- **Rate limits (429/503)** — Respected via `Retry-After` header, queued for retry.

---

## License

This project is licensed under the **[MIT LICENSE](LICENSE)**.
