# Auroic — Instagram AI Assistant

> **⚠️ Beta Version** — This project is under active development. Features may change, and some edge cases are still being refined.

**Auroic** is a local-first Instagram DM automation agent built by **[Kaushal Krishna](https://github.com/kaushalkrishnax)**. It runs a headless Chromium browser, intercepts Instagram's internal GraphQL traffic and Websocket events to read messages in real time, routes each message through a local classification model, and dispatches one of several actions — text reply, emoji reaction, translation, or acknowledgement — via a second LLM call only when needed.

Everything runs on your machine. No cloud relay. No credential storage beyond your browser profile.

---

## Architecture

### Browser & Session (`src/automation/`)

- Playwright launches a **persistent headless Chromium context** using a local profile directory. The same login session persists across restarts — no re-authentication needed.
- A single page navigates to Instagram. Two interception layers run in parallel:
  - **GraphQL** (`/api/graphql` POST responses) — used only at startup to seed the inbox (`PolarisDirectInboxQuery`) and load thread history (`IGDThreadDetailMainViewContainerQuery`).
  - **WebSocket** (`/ig_message_sync` frames) — used for all real-time events: new messages, edits, deletes, and reactions.
- On first boot, the bot auto-detects its own Facebook ID from the WebSocket stream and persists it to `runtime.json`. This is used throughout to filter out the bot's own messages and prevent reply loops.
- Page and context crash/close events reset internal state; the next event triggers an automatic reconnect.

### Event Bus (`src/events.ts`)

- All parsed events (`NEW_MESSAGE`, `EDIT`, `DELETE`, `REACTION_ADD/REMOVE`, `ROUTER_DECISION`, `OUTGOING`, `CONFIG_CHANGED`) are emitted on a central `EventEmitter`.
- `src/index.ts` subscribes to this bus and calls the processing pipeline for new messages and edits.
- The SSE endpoint in the HTTP server also subscribes to the same bus to stream events to the dashboard in real time.

### Processing Pipeline (`src/router/pipeline.ts`)

Each incoming message goes through this sequence:

1. **Load** the message from SQLite by `mid`.
2. **Skip** if it's the bot's own message, already processed, locked by a concurrent run, or has no text.
3. **Detect triggers** — mentions (e.g. `@auroic.ai`), hashtags (e.g. `#bot`), keywords, or direct replies. If matched, the trigger text is replaced with `@BOT` before routing.
4. **Build a 5-message sliding window** from recent DB history for context.
5. **Invoke the router** — a local Ollama model (`auroic-router-0.6b`) classifies the window and returns a structured decision: `TYPE`, `TARGET`, `EFFORT`, `TITLE`.
6. **Resolve the target message** — the router's `Mx` index is converted to an actual `mid`. If the router accidentally targets the bot's own message, the nearest valid user message is used instead.
7. **Dispatch the action** via `src/router/dispatcher.ts`.
8. Log the decision to the `outgoing` table and mark the message as processed.

Per-message **processing locks** in SQLite prevent duplicate handling on crash recovery. Stale locks older than 2 minutes are cleared at boot.

### Two-Model Strategy

| Stage | Model | Purpose |
|---|---|---|
| Router | Local Ollama (`auroic-router-0.6b`) | Fast, free classification — action type, target, effort level |
| LLM | OpenAI-compatible API | Text generation and translation, called only when router says `text` or `translate` |

The router is a **custom fine-tuned model** — trained specifically for this task - [`auroic-router-0.6b`](https://github.com/kaushalkrishnax/auroic-router). It takes a 5-message window (`M1`–`M5`, oldest to newest) and returns a structured decision:

- **TYPE** — what action to take (`text`, `react`, `translate`, `acknowledge`, `ignore`, etc.)
- **TARGET** — which message in the window to act on (`M1`–`M5`)
- **TITLE** — a canonical hint passed to the next LLM call (e.g. the emoji name for reactions, or a topic label for text generation)
- **EFFORT** — how capable a model is needed (`low`, `medium`, `high`), applied at runtime to select the appropriate LLM from `runtime.json`

Running locally via Ollama means routing adds zero API cost and near-zero latency. The expensive LLM is only invoked when the router explicitly asks for it.

### Action Types (`src/router/actions/`)

| Type | Behaviour |
|---|---|
| `text` | Generates a reply via LLM with a 5-message window as context. Targets the resolved `Mx` message. |
| `translate` | Translates the target message text via LLM. Effort level is either router-assigned or fixed in config. |
| `react` | Adds an emoji reaction to the target message. Emoji name comes from `TITLE`. |
| `acknowledge` | Navigates to the chat (used when presence is needed without a reply). |
| `ignore` | Skips all further processing. No network call, no DB write. |
| `media` | Sends a sticker (`effort=low`) or GIF (`effort=medium/high`). Search term comes from `TITLE`. |
| `command` | Stub — reserved for future command-parsing capability. |

### Runtime Configuration (`src/runtime/`)

Configuration is split into two tiers:

- **`.env`** — Boot-time secrets (`AI_API_KEY`, `INSTAGRAM_USERNAME`, `INSTAGRAM_PASSWORD`, `CHROMIUM_PROFILE_DIR`, `DB_PATH`). Immutable after start.
- **`runtime.json`** — All tunables: chat IDs to monitor, trigger lists, LLM system prompt, model names per effort level, router host/model, token caps, translate effort. This file is **watched with `fs.watch`** and hot-reloaded without restart. A `CONFIG_CHANGED` event is emitted so the dashboard can reflect updates instantly.

### Database (`src/db/`)

SQLite via **Drizzle ORM**. Tables:

- `users` — sender profile info (fbid, username, full name, profile pic, verified status)
- `chats` — chat metadata (title, image, group flag, muted flag, last processed mid)
- `chat_participants` — join table linking users to chats
- `messages` — full message records with processing state (`processedAt`, `processingLockAt`), edit/delete flags, reply-to mid, and content type
- `outgoing` — audit log of every action dispatched (type, content, timestamp)
- `media` — media attachments parsed from messages
- `reactions` — per-message reactions with sender and emoji

### HTTP API & Dashboard (`src/api/server.ts`)

Hono HTTP server running on **http://localhost:3789**. Open it in a browser to see all collected data in real time and tune the full config without touching any files directly.

| Method | Route | Description |
|---|---|---|
| `GET` | `/` | Live HTML dashboard — all data at a glance |
| `GET` | `/events` | SSE stream — real-time event feed with 15s heartbeat |
| `GET/POST` | `/config` | Read or write `runtime.json` (hot-reload triggers automatically on write) |
| `GET` | `/api/chats` | All chats from DB |
| `GET` | `/api/chats/:id/messages` | Messages for a specific chat |
| `GET` | `/api/messages` | Recent messages across all chats |
| `GET` | `/api/users` | All tracked users |
| `GET` | `/api/media` | Recent media attachments |
| `GET` | `/api/reactions` | Recent reactions |
| `GET` | `/api/outgoing` | Outgoing action log |

### Chat Interaction (`src/automation/chat.ts`)

DOM operations (reactions, reply-select, message send) use **index-based alignment** between the SQLite message window and the live DOM message groups. The window is capped to `min(10, DOM groups, DB rows)` to prevent index mismatches. This is more reliable than text-based DOM search.

---

## Quick Start

### Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 20 LTS |
| Ollama | Latest (for local router model) |
| Docker | ≥ 24 _(optional)_ |

### Configuration

```bash
cp .env.example .env
```

Edit `.env` for secrets, and `src/runtime/runtime.json` for chat IDs, triggers, models, and prompts. See the inline comments in each file.

### Run

```bash
# Install deps (also runs playwright install chromium-headless-shell)
npm install

# Development (watch mode)
npm run dev

# Production
npm run build
node dist/index.js
```

### Docker

```bash
docker build -t auroic .
docker run -d \
  --name auroic \
  --network=host \
  --env-file .env \
  auroic
```

---

## Triggers

Configured in `runtime.json` under `triggers`:

```json
{
  "mentions": ["@auroic.ai", "@bot"],
  "hashtags": ["#bot"],
  "keywords": ["hi auroic"],
  "onReply": true
}
```

All trigger fields accept multiple values. `onReply: true` activates the bot when someone replies directly to one of its messages.

---

## Reliability

- **Processing locks** — messages are locked in SQLite before processing. Stale locks (> 2 min) are cleared at boot to recover from unclean shutdowns.
- **Automatic reconnect** — browser and page crash/close events reset session state; the next event triggers re-init.
- **Bot self-filter** — the bot's own `fbId` is used to skip its own messages at the event handler, pipeline, and target-resolver levels.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` close the DB and disconnect the browser cleanly.

---

## Error Handling

- **Selector failures** — Caught and logged; the chat is skipped for that cycle.
- **Network failures** — Retried with exponential backoff.
- **Browser disconnect** — Auto-reconnects on the next poll cycle, re-opens dead tabs.
- **AI API failures** — Retried; if still failing, the chat is skipped (never crashes).
- **Rate limits (429/503)** — Respected via `Retry-After` header, queued for retry.

---

## License

This project is licensed under the **[MIT LICENSE](LICENSE)**.
