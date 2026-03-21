---
title: Auroic
emoji: 🤖
colorFrom: blue
colorTo: purple
sdk: docker
pinned: false
app_port: 3789
---

# Auroic — Instagram AI Assistant

> **⚠️ Beta Version** — This project is under active development. Features may change, and some edge cases are still being refined.

**Auroic** is a local-first Instagram DM automation agent. It runs a headless Chromium browser, intercepts Instagram's internal GraphQL traffic and WebSocket events to read messages in real time, routes each message through a local classification model, and dispatches intelligent actions — text replies, emoji reactions, GIFs, stickers, voice notes, music playback, and more — via LLM calls only when needed.

Everything runs on your machine. No cloud relay. No credential storage beyond your browser profile.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
  - [Browser & Session](#browser--session)
  - [Event Bus](#event-bus)
  - [Processing Pipeline](#processing-pipeline)
  - [Two-Model Strategy](#two-model-strategy)
  - [Action Types](#action-types)
  - [Runtime Configuration](#runtime-configuration)
  - [Database](#database)
  - [HTTP API & Dashboard](#http-api--dashboard)
  - [Chat Interaction](#chat-interaction)
  - [Command System](#command-system)
  - [Text-to-Speech (TTS)](#text-to-speech-tts)
- [Quick Start](#quick-start)
  - [Prerequisites](#prerequisites)
  - [Model Setup](#model-setup)
  - [Configuration](#configuration)
  - [Virtual Audio Setup](#virtual-audio-setup-optional)
  - [Run the System](#run-the-system)
- [Reliability](#reliability)
- [Error Handling](#error-handling)
- [Acknowledgments](#acknowledgments)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## Features

- **🤖 Intelligent Message Routing** — Local GGUF model classifies messages and determines appropriate actions without LLM overhead
- **💬 Context-Aware Responses** — Maintains conversation history and generates human-like replies using OpenAI-compatible APIs
- **🎭 Rich Media Automation** — Send GIFs, stickers, voice notes, and play music
- **🗣️ Local TTS** — ONNX-based Kokoro TTS for generating natural voice notes (optional)
- **⚡ Real-Time Processing** — WebSocket interception for instant message handling
- **🔒 Local-First** — All processing happens on your machine; credentials never leave your system
- **📊 Live Dashboard** — Web UI at `localhost:3789` for monitoring and configuration
- **🎯 Smart Triggers** — Mentions, hashtags, keywords, and reply-based activation
- **🔄 Hot Reload** — Update configuration without restart via dashboard
- **📝 Command System** — Extensible command registry for custom actions (GIF search, voice notes, music playback, web search, etc.)
- **🛡️ Production-Ready** — Processing locks, crash recovery, graceful shutdown, Docker support

---

## Architecture

### Browser & Session

**Location:** `src/automation/`

- Playwright launches a **persistent headless Chromium context** using a local profile directory. The same login session persists across restarts — no re-authentication needed.
- A single page navigates to Instagram. Two interception layers run in parallel:
  - **GraphQL** (`/api/graphql` POST responses) — used only at startup to seed the inbox (`PolarisDirectInboxQuery`) and load thread history (`IGDThreadDetailMainViewContainerQuery`).
  - **WebSocket** (`/ig_message_sync` frames) — used for all real-time events: new messages, edits, deletes, and reactions.
- On first boot, the bot **auto-detects its own Facebook ID** from the `viewer` field in the GraphQL mailbox response. No manual config needed — it is set in memory at runtime.
- Page and context crash/close events reset internal state; the next event triggers an automatic reconnect.

### Event Bus

**Location:** `src/events.ts`

- All parsed events (`NEW_MESSAGE`, `EDIT`, `DELETE`, `REACTION_ADD/REMOVE`, `ROUTER_DECISION`, `OUTGOING`, `CONFIG_CHANGED`) are emitted on a central `EventEmitter`.
- `src/index.ts` subscribes to this bus and calls the processing pipeline for new messages and edits.
- The SSE endpoint in the HTTP server also subscribes to the same bus to stream events to the dashboard in real time.

### Processing Pipeline

**Location:** `src/router/pipeline.ts`

Each incoming message goes through this sequence:

1. **Load** the message from SQLite by `mid`.
2. **Skip** if it's the bot's own message, already processed, locked by a concurrent run, or has no text.
3. **Detect triggers** — mentions (e.g. `@auroic.ai`), hashtags (e.g. `#bot`), keywords (e.g. `hi auroic`), or direct replies to a bot message. If matched, the trigger text is replaced with `@BOT` before routing. Replies to bot messages are auto-tagged `@BOT` using the `replyToMessageId` stored in the DB — no DOM scraping needed.
4. **Check for command triggers** — If the message contains command keywords (e.g., `/gif`, `play music`, `send voice note`), classify and execute the command directly.
5. **Build a sliding context window** — last 5 processed messages as history (H1–H5) and up to 3 unprocessed user messages as candidates (C1–C3).
6. **Invoke the router** — a local `node-llama-cpp` GGUF model classifies the window and returns a structured decision: `TYPE`, `TARGET`, `EFFORT`, `TITLE`. Target slots above C3 (e.g. C4, C5) are clamped to C3.
7. **Resolve the target message** — the router's `Cx` slot is mapped back to a real candidate using right-alignment offset (the window is always right-aligned to C3).
8. **Dispatch the action** via `src/router/dispatcher.ts`.
9. **Mark all candidates processed** — the entire candidate batch is marked, preventing leftover messages from re-entering the next pipeline run.

Per-message **processing locks** in SQLite prevent duplicate handling on crash recovery. Stale locks older than 2 minutes are cleared at boot.

### Two-Model Strategy

| Stage  | Model                           | Purpose                                                                                               |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Router | Local GGUF via `node-llama-cpp` | Fast, free classification — action type, target, effort level                                         |
| LLM    | OpenAI-compatible API           | Text generation and translation, called only when router says `text` or when commands need generation |

The router is a **custom fine-tuned model** — [`auroic-router-0.6b`](https://github.com/kaushalkrishnax/auroic-router). It takes a history window (H1–H5, oldest to newest) and candidate messages (C1–C3) and returns a structured decision:

- **TYPE** — what action to take (`text`, `react`, `media`, `ignore`)
- **TARGET** — which candidate to act on (`C1`–`C3`); values above C3 are clamped
- **TITLE** — a canonical hint passed to the next LLM call or action handler (e.g. the emoji name for reactions, or a search query for GIFs and stickers)
- **EFFORT** — how capable a model is needed (`low`, `medium`, `high`), applied at runtime to select the appropriate LLM from `config.db`

Running locally via `node-llama-cpp` means routing adds zero API cost and near-zero latency. The expensive LLM is only invoked when the router explicitly asks for it.

### Action Types

**Location:** `src/router/actions/`

| Type     | Behavior                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`   | Generates a reply via LLM. History sent as H1–H5 context block, then a dummy `assistant: ok` turn, then only the target candidate as the final user message — clean turn structure with zero noise from other candidates. |
| `react`  | Adds an emoji reaction to the target message. Emoji name comes from `TITLE`.                                                                                                                                              |
| `ignore` | Skips all further processing. No network call, no DB write.                                                                                                                                                               |
| `media`  | Tries sticker first; falls back to GIF in the same already-open dialog if no sticker result is found. Search term comes from `TITLE`.                                                                                     |

### Runtime Configuration

**Location:** `src/runtime/`

Configuration is split into two tiers:

- **`.env`** — Boot-time secrets (`AI_API_KEY`, `INSTAGRAM_USERNAME`, `INSTAGRAM_PASSWORD`, `CHROMIUM_PROFILE_DIR`, `DB_PATH`, `INSTAGRAM_CHAT_IDS`). Immutable after start. `INSTAGRAM_CHAT_IDS` is a comma-separated list of chat IDs to monitor.
- **`config.db`** — SQLite database containing all tunables: trigger lists, LLM system prompt, model names per effort level, router model path/prompt/options, token caps, command configurations, TTS settings. No sensitive data. Configuration is **hot-reloaded** via the dashboard or API without restart.

### Database

**Location:** `src/db/`

Two SQLite databases via **Drizzle ORM**:

#### State Database (`state.db`)

- `users` — sender profile info (fbid, username, full name, profile pic, verified status)
- `conversations` — chat metadata (title, image, group flag, muted flag, last processed mid)
- `chat_participants` — join table linking users to conversations
- `messages` — full message records with processing state (`processedAt`, `processingLockAt`), edit/delete flags, reply-to mid, and content type
- `outgoing` — audit log of every action dispatched (type, content, timestamp)
- `media` — media attachments parsed from messages
- `reactions` — per-message reactions with sender and emoji

#### Config Database (`config.db`)

- `runtime_settings` — JSON-based configuration (triggers, LLM settings, router settings, Instagram settings, TTS settings, debug flags)
- `command_config` — per-command configuration (enabled/disabled state, aliases, filter keywords, metadata)

### HTTP API & Dashboard

**Location:** `src/api/server.ts`

Hono HTTP server running on **http://localhost:3789**. Open it in a browser to see all collected data in real time and tune the full config without touching any files directly.

| Method     | Route                             | Description                                                                    |
| ---------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `GET`      | `/`                               | Live HTML dashboard — all data at a glance                                     |
| `GET`      | `/events`                         | SSE stream — real-time event feed with 15s heartbeat                           |
| `GET/POST` | `/config`                         | Read or write `config.db` runtime settings (hot-reload triggers automatically) |
| `GET`      | `/api/conversations`              | All conversations from DB                                                      |
| `GET`      | `/api/conversations/:id/messages` | Messages for a specific chat                                                   |
| `GET`      | `/api/messages`                   | Recent messages across all conversations                                       |
| `GET`      | `/api/users`                      | All tracked users                                                              |
| `GET`      | `/api/media`                      | Recent media attachments                                                       |
| `GET`      | `/api/reactions`                  | Recent reactions                                                               |
| `GET`      | `/api/outgoing`                   | Outgoing action log                                                            |

### Chat Interaction

**Location:** `src/automation/chat.ts`

DOM operations (reactions, reply-select, message send, media automation) use **index-based alignment** between the SQLite message window and the live DOM message groups. The window is capped to `min(10, DOM groups, DB rows)` to prevent index mismatches. This is more reliable than text-based DOM search.

### Command System

**Location:** `src/command/`

The command system provides extensible, keyword-based actions that bypass the router when explicitly triggered. Commands are classified using token matching against configured aliases and filter keywords.

**Available Commands:**

| Command           | Trigger Keywords            | Action Type | Description                                       |
| ----------------- | --------------------------- | ----------- | ------------------------------------------------- |
| `send_gif`        | `gif`, `meme`               | media       | Search and send a GIF matching the query          |
| `send_sticker`    | `sticker`                   | media       | Search and send a sticker                         |
| `send_voice_note` | `voice`, `speak`            | media       | Generate TTS audio and send as voice note         |
| `play_music`      | `play`, `music`, `song`     | media       | Find and play music via Instagram's native player |
| `send_image`      | `create`, `pic`, `generate` | media       | Generate and send an image (TODO)                 |
| `search_web`      | `search`, `find`, `web`     | text        | Search the web and return results (TODO)          |

Commands are managed via `config.db` and can be enabled/disabled, aliased, and filtered per-command through the dashboard.

### Text-to-Speech (TTS)

**Location:** `src/runtime/tts.ts`

Auroic uses the **Kokoro-82M ONNX model** for local text-to-speech generation. TTS is **optional** but enables voice note commands.

**Features:**

- Local ONNX inference via `onnxruntime-node`
- Multiple voice options (American/British, Female/Male)
- Supports quantized (q8) and full precision (fp16, fp32) models
- Automatic IPA phonemization using CMU Pronouncing Dictionary
- Integrates with PipeWire virtual audio for seamless Instagram voice message recording

**Supported Voices:**

- `af`, `af_bella`, `af_nicole`, `af_sarah`, `af_sky`
- `am_adam`, `am_michael`
- `bf_emma`, `bf_isabella`
- `bm_george`, `bm_lewis`

---

## Quick Start

### Prerequisites

| Requirement         | Version/Details                               |
| ------------------- | --------------------------------------------- |
| Node.js             | ≥ 20 LTS                                      |
| llama.cpp           | For loading GGUF router model via `node-llama-cpp` |
| Router Model        | `auroic-router-0.6b.q8_0.gguf` (**Required**) |
| TTS Model           | Kokoro-82M ONNX (Optional, for voice notes)   |
| Docker              | ≥ 24 _(optional)_                             |
| PipeWire/PulseAudio | Required for TTS voice note recording (Linux) |

---

### Model Setup

#### 1. Router Model (**Required**)

The router model is **essential** for Auroic to function. Download and place it in your project:

```bash
# Create model directory
mkdir -p models/auroic-router

# Download the router model (q8 quantized, ~600MB)
curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/auroic-router-0.6b.q8_0.gguf?download=true" \
  -o models/auroic-router/auroic-router-0.6b.q8_0.gguf

# Download the Modelfile (configuration)
curl -L "https://huggingface.co/kaushalkrishnax/auroic-router-0.6b/resolve/main/gguf/Modelfile" \
  -o models/auroic-router/Modelfile
```

**File structure:**

```
models/auroic-router/
├── auroic-router-0.6b.q8_0.gguf
└── Modelfile
```

The router uses `node-llama-cpp` to load the GGUF model directly. Override paths via:

```bash
ROUTER_MODEL_PATH=./models/auroic-router/auroic-router-0.6b.q8_0.gguf
ROUTER_MODELFILE_PATH=./models/auroic-router/Modelfile
```

#### 2. TTS Model (**Optional**)

The Kokoro TTS model enables voice note generation. If you want this feature, download one of the following:

```bash
# Create TTS model directories
mkdir -p models/kokoro-tts/onnx
mkdir -p models/kokoro-tts/voices

# Option 1: FP16 model (~160MB, higher quality)
curl -L "https://huggingface.co/onnx-community/Kokoro-82M-ONNX/resolve/main/onnx/model_fp16.onnx?download=true" \
  -o models/kokoro-tts/onnx/model_fp16.onnx

# Option 2: Quantized Q8 model (~82MB, faster, recommended)
curl -L "https://huggingface.co/onnx-community/Kokoro-82M-ONNX/resolve/main/onnx/model_quantized.onnx?download=true" \
  -o models/kokoro-tts/onnx/model_quantized.onnx
```

**File structure:**

```
models/kokoro-tts/
├── onnx/
│   ├── model_fp16.onnx       # OR
│   └── model_quantized.onnx  # (q8)
├── voices/
│   ├── af_nicole.bin
│   ├── af_bella.bin
│   └── ...
└──  ...
```

**Download additional voices** from the [Kokoro ONNX repository](https://huggingface.co/onnx-community/Kokoro-82M-ONNX/tree/main/voices).

### Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit with your credentials
nano .env
```

**Required `.env` variables:**

```bash
# Instagram credentials
INSTAGRAM_USERNAME=your_instagram_username
INSTAGRAM_PASSWORD=your_instagram_password
INSTAGRAM_CHAT_IDS=chat_id_1,chat_id_2,chat_id_3

# OpenAI-compatible API
AI_API_URL=https://api.openai.com/v1/chat/completions
AI_API_KEY=your_api_key

# Paths (optional overrides)
DB_PATH=./data/state.db
PROFILE_DIR=./data/chrome-auroic
ROUTER_MODEL_PATH=./models/auroic-router/auroic-router-0.6b.q8_0.gguf
ROUTER_MODELFILE_PATH=./models/auroic-router/Modelfile
```

**Runtime configuration** (triggers, prompts, models, commands, TTS) is stored in `config.db` and can be edited via:

- **Dashboard UI**: `http://localhost:3789` → Config tab
- **API**: `POST /config` with JSON payload
- **Direct SQL**: Use Drizzle Studio (`npm run db:studio`) or SQLite client

See `.env.example` for all available variables.

---

### Virtual Audio Setup (Optional)

**Required for TTS voice notes on Linux.** Sets up a persistent virtual microphone (`tts_mic`) backed by a virtual sink (`tts_sink`).

#### PipeWire Setup

```bash
# Create setup script
mkdir -p ~/.local/bin
nano ~/.local/bin/tts-audio-setup.sh
```

**Script content:**

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

**Create systemd user service:**

```bash
mkdir -p ~/.config/systemd/user
nano ~/.config/systemd/user/tts-audio.service
```

**Service content:**

```ini
[Unit]
Description=Setup TTS virtual audio

[Service]
ExecStart=%h/.local/bin/tts-audio-setup.sh
Type=oneshot

[Install]
WantedBy=default.target
```

**Enable and verify:**

```bash
# Enable and start service
systemctl --user daemon-reload
systemctl --user enable tts-audio.service
systemctl --user start tts-audio.service

# Verify devices are created
pactl list short sinks | grep tts_sink
pactl list short sources | grep tts_mic
```

---

### Run the System

#### Local Development
```bash
# Install dependencies (also installs Playwright Chromium)
npm install

# Development mode (watch mode with auto-reload)
npm run dev
```

#### Production
```bash
# Build the project
npm run build
# Start the server
npm start
```
Or with PM2 for process management:

```bash
pm2 ecosystem.config.json 
```

#### Docker

**Option 1: Docker Compose (Recommended)**
```bash
# Start the service
docker compose up -d

# View logs
docker compose logs -f

# Stop the service
docker compose down
```

**Option 2: Docker CLI**
```bash
# Build image
docker build -t auroic .

# Run container
docker run -d \
  --name auroic \
  --network=host \
  --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/models:/app/models \
  auroic

# View logs
docker logs -f auroic
```

**Important:** Ensure models are downloaded before starting Docker container. The container expects models at `/app/models`.

---

## Triggers

Configured in `config.db` under `runtime_settings.triggers`:

```json
{
  "mentions": ["@auroic.ai", "@bot"],
  "hashtags": ["#bot"],
  "keywords": ["hi auroic"],
  "onReply": true
}
```

All trigger fields accept multiple values. `onReply: true` activates the bot when someone replies directly to one of its messages.

**Edit triggers via:**

- Dashboard: `http://localhost:3789` → Config → Triggers
- API: `POST /config` with updated JSON

---

## Reliability

- **Processing locks** — Messages are locked in SQLite before processing. Stale locks (> 2 min) are cleared at boot to recover from unclean shutdowns.
- **All-candidate mark** — After each pipeline run, all candidates in the batch are marked processed, not just the triggering message, preventing duplicate actions on the next run.
- **Automatic reconnect** — Browser and page crash/close events reset session state; the next event triggers re-init.
- **Bot self-filter** — The bot's own `fbId` (auto-detected at runtime) is used to skip its own messages at the event handler, pipeline, and target-resolver levels.
- **`<think>` block stripping** — Reasoning traces from thinking models are stripped from LLM responses before they are sent.
- **Graceful shutdown** — `SIGINT`/`SIGTERM` close the DB and disconnect the browser cleanly.
- **Automation lock** — Serialized execution of automation actions prevents race conditions and DOM conflicts.

---

## Error Handling

- **Selector failures** — Caught and logged; the chat is skipped for that cycle.
- **Network failures** — Retried with exponential backoff.
- **Browser disconnect** — Auto-reconnects on the next poll cycle, re-opens dead tabs.
- **AI API failures** — Retried; if still failing, the chat is skipped (never crashes).
- **Rate limits (429/503)** — Respected via `Retry-After` header, queued for retry.
- **TTS failures** — Commands gracefully degrade; errors logged without crashing the pipeline.

---

## Acknowledgments
- The open-source community for GGUF, ONNX, and Playwright tools
- Hugging Face for hosting the models
- The inspiration from various AI assistants and Instagram automation tools that came before
- The users who provided feedback and ideas during development

---

## Disclaimer
This project is for educational and experimental purposes only. Use it responsibly and in accordance with Instagram's terms of service. The author is not liable for any misuse or consequences arising from the use of this software.

## License

This project is licensed under the **[Apache License 2.0](LICENSE)**.

---

## Resources

- **Router Model**: [kaushalkrishnax/auroic-router-0.6b](https://huggingface.co/kaushalkrishnax/auroic-router-0.6b)
- **TTS Model**: [onnx-community/Kokoro-82M-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-ONNX)
- **Author**: [Kaushal Krishna](https://github.com/kaushalkrishnax)

