---
title: Auroic
emoji: 🤖
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# Auroic — Instagram AI Assistant

**Auroic** is a local-first Instagram DM automation agent.
It runs a headless Chromium session, reads Instagram events in real time, routes each message with a local model, and executes actions like text replies, reactions, GIF/sticker sends, voice notes, and music playback.

All processing is local. Credentials stay in your browser profile.

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
  - [Instagram OTP (2FA) Input](#instagram-otp-2fa-input)
  - [Run the System](#run-the-system)
- [Reliability](#reliability)
- [Error Handling](#error-handling)
- [Acknowledgments](#acknowledgments)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## Features

- **Local router** for fast low-cost action selection
- **Context-aware text replies** via OpenAI-compatible APIs
- **Media actions**: reactions, GIFs, stickers, voice notes, and music
- **Optional local TTS** via Kokoro ONNX service
- **Real-time message handling** via WebSocket interception
- **Dashboard** at `localhost:7860` for live monitoring and config
- **Hot-reload config** from dashboard/API without restart
- **Reliability features**: processing locks, reconnects, graceful shutdown

---

## Architecture

### Browser & Session

Playwright runs a persistent headless Chromium profile, so login sessions survive restarts.
Instagram data is captured through:

- GraphQL responses at startup (inbox/thread bootstrap)
- WebSocket frames for real-time events (new/edit/delete/reaction)

If Instagram requests 2FA during login, Auroic pauses startup and waits for OTP submission from the dashboard/API, then resumes the login flow.

The bot auto-detects its own Facebook ID at boot and reconnects automatically after page/context failures.

### Event Bus

All parsed events are emitted through a shared `EventEmitter`.
The pipeline consumes these events for processing, and the dashboard SSE stream uses the same event source.

### Processing Pipeline

Each message follows this flow:

1. Load message by `mid`.
2. Skip if self-message, already processed, locked, or empty.
3. Apply triggers (mention/hashtag/reply) and normalize trigger text to `@BOT`.
4. Check command format with slash delimiters (examples: `/gif/`, `/ play music /`). If matched, execute command directly.
5. Build context window: H1-H5 history + C1-C3 candidates.
6. Ask the local router for `TYPE`, `TARGET`, `EFFORT`, `TITLE`.
7. Resolve target candidate and dispatch action.
8. Mark candidate batch processed.

SQLite processing locks prevent duplicate handling and stale locks are cleared at boot.

### Two-Model Strategy

| Stage  | Model                 | Purpose                                          |
| ------ | --------------------- | ------------------------------------------------ |
| Router | Local Ollama model    | Fast local decision: action type, target, effort |
| LLM    | OpenAI-compatible API | Text generation/translation only when needed     |

Router output fields:

- `TYPE`: `text`, `react`, `media`, `ignore`
- `TARGET`: candidate slot (`C1`-`C3`)
- `TITLE`: hint for downstream action (emoji/search query/etc.)
- `EFFORT`: model tier (`low`, `medium`, `high`)

### Action Types

| Type     | Behavior                                               |
| -------- | ------------------------------------------------------ |
| `text`   | Generate reply with LLM using history + target message |
| `react`  | Add emoji reaction from `TITLE`                        |
| `ignore` | Skip processing                                        |
| `media`  | Try sticker first, then GIF fallback using `TITLE`     |

### Runtime Configuration

Configuration has two layers:

- **`.env`**: boot-time secrets and optional path overrides
- **`config.db`**: runtime settings (triggers, prompts, models, router, commands, TTS)

`config.db` changes hot-reload via dashboard/API.

### Database

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

Hono server runs on **http://localhost:7860** for live monitoring and config edits.

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
| `GET`      | `/api/otp/status`                 | 2FA status (`pending`, `requestedAt`) for dashboard/API clients                |
| `POST`     | `/api/otp/submit`                 | Submit OTP code (`{ "code": "123456" }`) when 2FA is pending                   |

### Chat Interaction

DOM actions use index-based alignment between DB rows and DOM message groups.
Window size is capped to `min(10, DOM groups, DB rows)` to avoid index mismatches.

### Command System

Commands are configurable actions that bypass the router when explicitly triggered.
They are matched by aliases/keywords and require slash-delimited command text.

**Available Commands:**

| Command           | Trigger Keywords        | Action Type | Description                                       |
| ----------------- | ----------------------- | ----------- | ------------------------------------------------- | --- |
| `send_gif`        | `gif`, `meme`           | media       | Search and send a GIF matching the query          |
| `send_sticker`    | `sticker`               | media       | Search and send a sticker                         |
| `send_voice_note` | `voice`, `speak`        | media       | Generate TTS audio and send as voice note         |
| `play_music`      | `play`, `music`, `song` | media       | Find and play music via Instagram's native player |     |

Commands are managed via `config.db` and can be enabled/disabled, aliased, and filtered per-command through the dashboard.

### Text-to-Speech (TTS)

Auroic uses a local **Kokoro ONNX FastAPI service** for TTS at `http://localhost:8000/tts`. TTS is optional and used by voice note commands.

**Current behavior:**

- Runtime config uses `tts.voice` only, which maps to Kokoro's voice options
- The app sends `{ text, voice, speed }` to the local `/tts` endpoint
- TTS output is returned as WAV audio and attached as a voice note

**Supported voice keys:**

- `alpha`
- `beta`
- `omega`
- `psi`

---

## Quick Start

### Prerequisites

| Requirement         | Version/Details                                    |
| ------------------- | -------------------------------------------------- |
| Node.js             | ≥ 20 LTS                                           |
| Ollama              | Local router inference service (`ollama serve`)    |
| Router Model        | `auroic-router:latest` in Ollama (**Required**)    |
| TTS Runtime         | Local FastAPI service (`models/kokoro_tts/app.py`) |
| Docker              | ≥ 24 _(optional)_                                  |
| PipeWire/PulseAudio | Required for TTS voice note recording (Linux)      |

---

### Model Setup

#### 1. Router Model in Ollama (**Required**)

The router model is **essential** for Auroic to function. Create it in Ollama using the bundled Modelfile:

```bash
# Start Ollama service
ollama serve

# Pull the router model (ensure Ollama is running and accessible)
ollama pull hf.co/kaushalkrishnax/auroic-router-0.6b:Q8_0

# Verify model is available
ollama list
```

**Expected local files:**

```
models/auroic-router/
└── Modelfile
```

Set `router.hostUrl` and `router.model` in `config.db` (Dashboard → Config → Router).

#### 2. TTS Model (**Optional**)

Kokoro TTS runs through the local Python service in `models/kokoro_tts/app.py`.

- The service loads Kokoro ONNX assets from Hugging Face
- TTS endpoint: `POST http://localhost:8000/tts`
- Request body: `{ "text": "...", "voice": "alpha|beta|omega|psi", "speed": 1.0 }`

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

# OpenAI-compatible API
AI_API_URL=https://api.openai.com/v1/chat/completions
AI_API_KEY=your_api_key

# Paths (optional overrides)
DB_PATH=./data/state.db
CHROMIUM_PROFILE_DIR=./data/chrome-auroic
CONFIG_DB_PATH=./data/config.db
```

**Runtime configuration** (triggers, prompts, LLM effort models, router host/model/options, commands, TTS) is stored in `config.db` and can be edited via:

- **Dashboard UI**: `http://localhost:7860` → Config tab
- **API**: `POST /config` with JSON payload
- **Direct SQL**: Use Drizzle Studio (`npm run db:studio`) or SQLite client

See `.env.example` for all available variables.

### Instagram OTP (2FA) Input

When Instagram challenges login with 2FA, Auroic now waits for OTP through the dashboard/API instead of terminal input.

1. Start Auroic normally.
2. Open the dashboard at `http://localhost:7860`.
3. If 2FA is required, an OTP panel appears in the top bar.
4. Enter the code and click **Submit** (or press Enter).
5. Auroic resumes Playwright login automatically after successful submission.

Notes:

- OTP is only accepted while status is pending.
- Pending status can be checked via `GET /api/otp/status`.
- API submission endpoint: `POST /api/otp/submit` with JSON body `{ "code": "123456" }`.
- The OTP wait window is time-limited (default 5 minutes), so submit promptly.

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

**Important:** Ensure Ollama is reachable from the app and `auroic-router:latest` exists in Ollama before starting the bot.

---

## Triggers

Defined in `config.db` under `runtime_settings.triggers`:

```json
{
  "mentions": ["@auroic.ai", "@bot"],
  "hashtags": ["#bot"],
  "keywords": ["hi auroic"],
  "onReply": true
}
```

Each field accepts multiple values. `onReply: true` enables reply-based activation.

**Edit triggers via:**

- Dashboard: `http://localhost:7860` → Config → Triggers
- API: `POST /config` with updated JSON

---

## Reliability

- **Processing locks** in SQLite avoid duplicate handling; stale locks are cleared at boot.
- **Batch marking** marks candidate messages processed after each run.
- **Auto reconnect** restores session after browser/page failures.
- **Self-filtering** ignores bot-owned messages using runtime-detected `fbId`.
- **`<think>` stripping** removes reasoning traces before sending replies.
- **Graceful shutdown** closes DB and browser on `SIGINT`/`SIGTERM`.
- **Automation lock** serializes DOM actions to avoid races.

---

## Error Handling

- Selector failures are logged and that chat cycle is skipped.
- Network/API failures retry with backoff.
- Browser disconnects are recovered automatically.
- Rate limits (`429`/`503`) honor `Retry-After`.
- TTS failures degrade gracefully without crashing the pipeline.

---

## Acknowledgments

- The open-source community for Ollama, Kokoro, and Playwright tools
- Hugging Face for hosting the models
- The users who provided feedback and ideas during development

---

## Disclaimer

For educational and experimental use only. Use responsibly and follow Instagram's terms of service. The author is not liable for misuse.

## License

This project is licensed under the **[Apache License 2.0](LICENSE)**.

---

## Resources

- **Router Model**: [kaushalkrishnax/auroic-router-0.6b](https://huggingface.co/kaushalkrishnax/auroic-router-0.6b)
- **TTS Model**: [leonelhs/kokoro-thewh1teagle](https://huggingface.co/leonelhs/kokoro-thewh1teagle)
- **Author**: [Kaushal Krishna](https://github.com/kaushalkrishnax)
