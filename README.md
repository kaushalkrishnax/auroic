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
- On first boot, the bot **auto-detects its own Facebook ID** from the `viewer` field in the GraphQL mailbox response. No manual config needed — it is set in memory at runtime.
- Page and context crash/close events reset internal state; the next event triggers an automatic reconnect.

### Event Bus (`src/events.ts`)

- All parsed events (`NEW_MESSAGE`, `EDIT`, `DELETE`, `REACTION_ADD/REMOVE`, `ROUTER_DECISION`, `OUTGOING`, `CONFIG_CHANGED`) are emitted on a central `EventEmitter`.
- `src/index.ts` subscribes to this bus and calls the processing pipeline for new messages and edits.
- The SSE endpoint in the HTTP server also subscribes to the same bus to stream events to the dashboard in real time.

### Processing Pipeline (`src/router/pipeline.ts`)

Each incoming message goes through this sequence:

1. **Load** the message from SQLite by `mid`.
2. **Skip** if it's the bot's own message, already processed, locked by a concurrent run, or has no text.
3. **Detect triggers** — mentions (e.g. `@auroic.ai`), hashtags (e.g. `#bot`), or direct replies to a bot message. If matched, the trigger text is replaced with `@BOT` before routing. Replies to bot messages are auto-tagged `@BOT` using the `replyToMessageId` stored in the DB — no DOM scraping needed.
4. **Build a sliding context window** — last 5 processed messages as history (H1–H5) and up to 3 unprocessed user messages as candidates (C1–C3).
5. **Invoke the router** — a local Ollama model classifies the window and returns a structured decision: `TYPE`, `TARGET`, `EFFORT`, `TITLE`. Target slots above C3 (e.g. C4, C5) are clamped to C3.
6. **Resolve the target message** — the router's `Cx` slot is mapped back to a real candidate using right-alignment offset (the window is always right-aligned to C3).
7. **Dispatch the action** via `src/router/dispatcher.ts`.
8. **Mark all candidates processed** — the entire candidate batch is marked, preventing leftover messages from re-entering the next pipeline run.

Per-message **processing locks** in SQLite prevent duplicate handling on crash recovery. Stale locks older than 2 minutes are cleared at boot.

### Two-Model Strategy

| Stage  | Model                               | Purpose                                                                             |
| ------ | ----------------------------------- | ----------------------------------------------------------------------------------- |
| Router | Local Ollama (`auroic-router-0.6b`) | Fast, free classification — action type, target, effort level                       |
| LLM    | OpenAI-compatible API               | Text generation and translation, called only when router says `text` or `translate` |

The router is a **custom fine-tuned model** — trained specifically for this task - [`auroic-router-0.6b`](https://github.com/kaushalkrishnax/auroic-router). It takes a history window (H1–H5, oldest to newest) and candidate messages (C1–C3) and returns a structured decision:

- **TYPE** — what action to take (`text`, `react`, `translate`, `acknowledge`, `ignore`, `media`, etc.)
- **TARGET** — which candidate to act on (`C1`–`C3`); values above C3 are clamped
- **TITLE** — a canonical hint passed to the next LLM call (e.g. the emoji name for reactions, or a search query for media like gif and stickers)
- **EFFORT** — how capable a model is needed (`low`, `medium`, `high`), applied at runtime to select the appropriate LLM from `runtime.json`

Running locally via Ollama means routing adds zero API cost and near-zero latency. The expensive LLM is only invoked when the router explicitly asks for it.

### Action Types (`src/router/actions/`)

| Type     | Behaviour                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`   | Generates a reply via LLM. History sent as H1–H5 context block, then a dummy `assistant: ok` turn, then only the target candidate as the final user message — clean turn structure with zero noise from other candidates. |
| `react`  | Adds an emoji reaction to the target message. Emoji name comes from `TITLE`.                                                                                                                                              |
| `ignore` | Skips all further processing. No network call, no DB write.                                                                                                                                                               |
| `media`  | Tries sticker first; falls back to GIF in the same already-open dialog if no sticker result is found. Search term comes from `TITLE`.                                                                                     |

### Runtime Configuration (`src/runtime/`)

Configuration is split into two tiers:

- **`.env`** — Boot-time secrets (`AI_API_KEY`, `INSTAGRAM_USERNAME`, `INSTAGRAM_PASSWORD`, `CHROMIUM_PROFILE_DIR`, `DB_PATH`, `INSTAGRAM_CHAT_IDS`). Immutable after start. `INSTAGRAM_CHAT_IDS` is a comma-separated list of chat IDs to monitor.
- **`runtime.json`** — All tunables: trigger lists, LLM system prompt, model names per effort level, router host/model, token caps, translate effort. No sensitive data. This file is **watched with `fs.watch`** and hot-reloaded without restart.

### Database (`src/db/`)

SQLite via **Drizzle ORM**. Tables:

- `users` — sender profile info (fbid, username, full name, profile pic, verified status)
- `conversations` — chat metadata (title, image, group flag, muted flag, last processed mid)
- `chat_participants` — join table linking users to conversations
- `messages` — full message records with processing state (`processedAt`, `processingLockAt`), edit/delete flags, reply-to mid, and content type
- `outgoing` — audit log of every action dispatched (type, content, timestamp)
- `media` — media attachments parsed from messages
- `reactions` — per-message reactions with sender and emoji

### HTTP API & Dashboard (`src/api/server.ts`)

Hono HTTP server running on **http://localhost:3789**. Open it in a browser to see all collected data in real time and tune the full config without touching any files directly.

| Method     | Route                             | Description                                                               |
| ---------- | --------------------------------- | ------------------------------------------------------------------------- |
| `GET`      | `/`                               | Live HTML dashboard — all data at a glance                                |
| `GET`      | `/events`                         | SSE stream — real-time event feed with 15s heartbeat                      |
| `GET/POST` | `/config`                         | Read or write `runtime.json` (hot-reload triggers automatically on write) |
| `GET`      | `/api/conversations`              | All conversations from DB                                                 |
| `GET`      | `/api/conversations/:id/messages` | Messages for a specific chat                                              |
| `GET`      | `/api/messages`                   | Recent messages across all conversations                                  |
| `GET`      | `/api/users`                      | All tracked users                                                         |
| `GET`      | `/api/media`                      | Recent media attachments                                                  |
| `GET`      | `/api/reactions`                  | Recent reactions                                                          |
| `GET`      | `/api/outgoing`                   | Outgoing action log                                                       |

### Chat Interaction (`src/automation/chat.ts`)

DOM operations (reactions, reply-select, message send) use **index-based alignment** between the SQLite message window and the live DOM message groups. The window is capped to `min(10, DOM groups, DB rows)` to prevent index mismatches. This is more reliable than text-based DOM search.

---

## Quick Start

### Prerequisites

| Requirement | Version                         |
| ----------- | ------------------------------- |
| Node.js     | ≥ 20 LTS                        |
| Ollama      | Latest (for local router model) |
| Docker      | ≥ 24 _(optional)_               |

### Setup Ollama

Ollama runs the local router model. Install it first:

```bash
# macOS / Linux (via brew)
brew install ollama

# Linux (direct)
curl -fsSL https://ollama.ai/install.sh | sh

# Then start the Ollama service
ollama serve
```

Once Ollama is running in the background, in a new terminal pull the router model:

```bash
ollama run hf.co/kaushalkrishnax/auroic-router-0.6b
```

This downloads the **auroic-router-0.6b** model (a custom fine-tuned 600M parameter model) and verifies it loads. The model will be cached locally for all subsequent runs. Leave Ollama running in the background — the bot will connect to it on `localhost:11434` during operation.

### Configuration

```bash
cp .env.example .env
```

Edit `.env` for secrets and chat IDs (`INSTAGRAM_CHAT_IDS=id1,id2,id3`), and `src/runtime/runtime.json` for triggers, models, and prompts. See `.env.example` for all available variables.

The command-classifier model is loaded from the local `indic-sbert-onnx/` folder in project root. No `git clone` step is required.

---

### Persistent Virtual Mic Setup (PipeWire)

This sets up a virtual microphone (`tts_mic`) backed by a virtual sink (`tts_sink`) automatically on startup.

```bash
# Create setup script
mkdir -p ~/.local/bin
nano ~/.local/bin/tts-audio-setup.sh
```

```bash
#!/bin/bash

# Remove old modules (avoid duplicates)
pactl unload-module module-null-sink 2>/dev/null
pactl unload-module module-remap-source 2>/dev/null

# Create virtual sink (speaker)
pactl load-module module-null-sink \
  sink_name=tts_sink \
  sink_properties=device.description=TTS_SINK

# Create virtual microphone from sink monitor
pactl load-module module-remap-source \
  master=tts_sink.monitor \
  source_name=tts_mic \
  source_properties=device.description=TTS_MIC
```

```bash
# Make script executable
chmod +x ~/.local/bin/tts-audio-setup.sh
```

```bash
# Create systemd user service
mkdir -p ~/.config/systemd/user
nano ~/.config/systemd/user/tts-audio.service
```

```ini
[Unit]
Description=Setup TTS virtual audio

[Service]
ExecStart=%h/.local/bin/tts-audio-setup.sh
Type=oneshot

[Install]
WantedBy=default.target
```

```bash
# Enable and start service
systemctl --user daemon-reload
systemctl --user enable tts-audio.service
systemctl --user start tts-audio.service
```

```bash
# Verify devices
pactl list short sinks
pactl list short sources
```

---

### Run the System

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
- **All-candidate mark** — after each pipeline run, all candidates in the batch are marked processed, not just the triggering message, preventing duplicate actions on the next run.
- **Automatic reconnect** — browser and page crash/close events reset session state; the next event triggers re-init.
- **Bot self-filter** — the bot's own `fbId` (auto-detected at runtime) is used to skip its own messages at the event handler, pipeline, and target-resolver levels.
- **`<think>` block stripping** — reasoning traces from thinking models are stripped from LLM responses before they are sent.
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
