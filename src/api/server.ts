/**
 * Hono HTTP server.
 *
 * Routes:
 *   GET  /                       — live dashboard HTML
 *   GET  /events                 — SSE stream (real-time events)
 *   GET  /config                 — read runtime.json
 *   POST /config                 — write runtime.json
 *   GET  /api/conversations              — all conversations
 *   GET  /api/conversations/:id/messages — messages for a chat
 *   GET  /api/messages           — all messages (recent)
 *   GET  /api/users              — all users
 *   GET  /api/media              — recent media
 *   GET  /api/reactions          — recent reactions
 *   GET  /api/outgoing           — outgoing message log
 *   GET  /api/commands                     — all command rows
 *   GET  /api/commands/registry            — available registry command names
 *   POST /api/commands                     — create command row (embedding generated)
 *   PATCH /api/commands/:id                — update command row (embedding regenerated)
 *   DELETE /api/commands/:id               — delete command row
 *   PATCH /api/commands/feature            — toggle commands.enabled in runtime.json
 *   PATCH /api/commands/toggle             — toggle per-command enabled in runtime.json
 *   PATCH /api/commands/filter-words       — set per-command filter words in runtime.json
 *   GET  /api/commands/setup-status        — local model directory status + onnx file list
 *   POST /api/commands/model               — select active onnx model file
 *   POST /api/commands/download-model      — stream-download an LFS model file
 *   GET  /api/commands/download-status     — current download progress
 *   POST /api/commands/download-cancel     — abort active download
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import logger from "@/utils/logger.js";
import { eventBus } from "@/events.js";
import { getRuntimePath, reloadRuntime, BOT_FBID } from "@/runtime/index.js";
import { getAllConversations } from "@/db/queries/conversations.js";
import { getAllMessages } from "@/db/queries/messages.js";
import { getAllUsers } from "@/db/queries/users.js";
import { getAllMedia } from "@/db/queries/media.js";
import { getAllReactions } from "@/db/queries/reactions.js";
import { getAllOutgoing } from "@/db/queries/outgoing.js";
import {
  deleteCommand,
  getAllCommands,
  getCommandById,
  insertCommand,
  updateCommand,
} from "@/db/queries/commands.js";
import { COMMAND_REGISTRY } from "@/command/commandRegistry.js";
import { generateTextEmbedding } from "@/command/embeddings.js";
import type { AppEvent } from "@/events.js";

// Paths

const DASHBOARD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dashboard/index.html",
);

// Commands model paths

const MODEL_DIR = path.join(process.cwd(), "indic-sbert-onnx");
const ONNX_DIR = path.join(MODEL_DIR, "onnx");
const HF_REPO = "https://huggingface.co/kaushalkrishnax/indic-sbert-onnx";
const ALLOWED_COMMAND_MODELS = ["model.onnx", "model_quantized.onnx"] as const;

function isAllowedCommandModel(modelFile: string): boolean {
  return (ALLOWED_COMMAND_MODELS as readonly string[]).includes(modelFile);
}

interface DownloadState {
  active: boolean;
  modelFile: string | null;
  downloaded: number;
  total: number;
  error: string | null;
  abortController: AbortController | null;
}
let downloadState: DownloadState = {
  active: false, modelFile: null, downloaded: 0, total: 0, error: null, abortController: null,
};

// App

const app = new Hono();

app.use("*", cors());

// Dashboard

app.get("/", async (c) => {
  try {
    const html = await fs.readFile(DASHBOARD_PATH, "utf-8");
    return c.html(html);
  } catch (err) {
    logger.warn("Could not load dashboard HTML", {
      error: (err as Error).message,
    });
    return c.text("Dashboard not available", 500);
  }
});

// SSE stream

app.get("/events", (c) => {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (event: AppEvent) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    writer.write(encoder.encode(data)).catch(() => cleanup());
  };

  const cleanup = () => {
    eventBus.off("event", send);
    writer.close().catch(() => {});
  };

  eventBus.on("event", send);

  const heartbeat = setInterval(() => {
    writer.write(encoder.encode(": heartbeat\n\n")).catch(() => {
      clearInterval(heartbeat);
      cleanup();
    });
  }, 15_000);

  c.req.raw.signal.addEventListener("abort", () => {
    clearInterval(heartbeat);
    cleanup();
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// Runtime config

app.get("/config", async (c) => {
  try {
    const raw = await fs.readFile(getRuntimePath(), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    // Merge runtime-detected bot identity so the dashboard can identify outgoing messages
    config.instagram = {
      ...((config.instagram as Record<string, unknown>) ?? {}),
      fbId: BOT_FBID,
    };
    return c.json(config);
  } catch (err) {
    logger.error("Failed to read config", { error: (err as Error).message });
    return c.json({ error: "Failed to read config" }, 500);
  }
});

app.post("/config", async (c) => {
  try {
    const body = await c.req.json<Record<string, unknown>>();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Invalid payload: expected a JSON object" }, 400);
    }

    const REQUIRED_SECTIONS: Record<string, string> = {
      llm: "object",
      triggers: "object",
    };

    for (const [key, expectedType] of Object.entries(REQUIRED_SECTIONS)) {
      if (key in body && typeof body[key] !== expectedType) {
        return c.json(
          { error: `Invalid config: "${key}" must be an ${expectedType}` },
          400,
        );
      }
    }

    const existingRaw = await fs.readFile(getRuntimePath(), "utf-8");
    const existing = JSON.parse(existingRaw) as Record<string, unknown>;
    const merged = { ...existing, ...body };

    await fs.writeFile(getRuntimePath(), JSON.stringify(merged, null, 2));
    return c.json({ success: true });
  } catch (err) {
    logger.error("Failed to write config", { error: (err as Error).message });
    return c.json({ error: "Failed to write config" }, 500);
  }
});

// Data API

app.get("/api/conversations", (c) => {
  try {
    return c.json(getAllConversations());
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/conversations/:id/messages", (c) => {
  try {
    const chatId = c.req.param("id");
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(getAllMessages(chatId, limit));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/messages", (c) => {
  try {
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(getAllMessages(undefined, limit));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/users", (c) => {
  try {
    return c.json(getAllUsers());
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/media", (c) => {
  try {
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(getAllMedia(limit));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/reactions", (c) => {
  try {
    const limit = Number(c.req.query("limit") ?? 200);
    return c.json(getAllReactions(limit));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/outgoing", (c) => {
  try {
    const limit = Number(c.req.query("limit") ?? 200);
    return c.json(getAllOutgoing(limit));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/commands", (c) => {
  try {
    return c.json(getAllCommands());
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/commands/registry", (c) => {
  try {
    return c.json(
      COMMAND_REGISTRY.map((commandDef) => ({
        command: commandDef.name,
        actionType: commandDef.actionType,
        description: commandDef.description,
        commandWords: commandDef.commandWords,
      })),
    );
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.patch("/api/commands/filter-words", async (c) => {
  try {
    const { commandName, words } = await c.req.json<{ commandName: string; words: string[] }>();
    if (!commandName) return c.json({ error: "commandName is required" }, 400);
    if (!Array.isArray(words)) return c.json({ error: "words must be an array" }, 400);

    const registryDef = COMMAND_REGISTRY.find((d) => d.name === commandName);
    if (!registryDef) return c.json({ error: "command not found in registry" }, 400);

    const raw = await fs.readFile(getRuntimePath(), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const prev = (config.commands ?? {}) as Record<string, unknown>;
    const prevFilterWords = { ...((prev.filterWords as Record<string, string[]>) ?? {}) };

    const cleanWords = words.map((w) => w.trim().toLowerCase()).filter(Boolean);

    if (cleanWords.length === 0) {
      // Empty array = clear override, fall back to registry defaults
      delete prevFilterWords[commandName];
    } else {
      prevFilterWords[commandName] = cleanWords;
    }

    config.commands = { ...prev, filterWords: prevFilterWords };
    await fs.writeFile(getRuntimePath(), JSON.stringify(config, null, 2));
    reloadRuntime();

    return c.json({ success: true, words: cleanWords, isDefault: cleanWords.length === 0 });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/commands", async (c) => {
  try {
    const body = await c.req.json<{ command: string; text: string }>();
    const command = body.command?.trim();
    const text = body.text?.trim();

    if (!command) {
      return c.json({ error: "command is required" }, 400);
    }
    if (!text) {
      return c.json({ error: "text is required" }, 400);
    }

    const registryDef = COMMAND_REGISTRY.find((d) => d.name === command);
    if (!registryDef) {
      return c.json({ error: "command must exist in registry" }, 400);
    }

    const embedding = await generateTextEmbedding(text);
    const id = insertCommand({
      command,
      text,
      embedding: JSON.stringify(embedding),
    });

    if (!id) {
      return c.json({ error: "Failed to create command row" }, 500);
    }

    return c.json({ success: true, id });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.patch("/api/commands/feature", async (c) => {
  try {
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    if (typeof enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }

    const raw = await fs.readFile(getRuntimePath(), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const prev = (config.commands ?? {}) as Record<string, unknown>;
    config.commands = { ...prev, enabled };
    await fs.writeFile(getRuntimePath(), JSON.stringify(config, null, 2));
    reloadRuntime();

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.patch("/api/commands/:id", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) {
      return c.json({ error: "Invalid command row id" }, 400);
    }

    const body = await c.req.json<{ command?: string; text?: string }>();
    const existing = getCommandById(id);

    if (!existing) {
      return c.json({ error: "Command row not found" }, 404);
    }

    const command = body.command?.trim() ?? existing.command;
    const text = body.text?.trim() ?? existing.text;

    if (!command) {
      return c.json({ error: "command cannot be empty" }, 400);
    }
    if (!text) {
      return c.json({ error: "text cannot be empty" }, 400);
    }

    const registryDef = COMMAND_REGISTRY.find((d) => d.name === command);
    if (!registryDef) {
      return c.json({ error: "command must exist in registry" }, 400);
    }

    const embedding = await generateTextEmbedding(text);
    const changes = updateCommand(id, {
      command,
      text,
      embedding: JSON.stringify(embedding),
    });

    if (changes === 0) {
      return c.json({ error: "Command row not found" }, 404);
    }

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.delete("/api/commands/:id", (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) {
      return c.json({ error: "Invalid command row id" }, 400);
    }

    const changes = deleteCommand(id);
    if (changes === 0) {
      return c.json({ error: "Command row not found" }, 404);
    }

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

async function isLfsPointer(filePath: string): Promise<boolean> {
  try {
    const handle = await fs.open(filePath, "r");
    const buf = Buffer.alloc(LFS_POINTER_PREFIX.length);
    await handle.read(buf, 0, LFS_POINTER_PREFIX.length, 0);
    await handle.close();
    return buf.toString("utf8").startsWith(LFS_POINTER_PREFIX);
  } catch {
    return false;
  }
}

app.get("/api/commands/setup-status", async (c) => {
  try {
    const modelDirExists = await fs
      .stat(MODEL_DIR)
      .then((s) => s.isDirectory())
      .catch(() => false);
    const onnxDirExists = await fs
      .stat(ONNX_DIR)
      .then((s) => s.isDirectory())
      .catch(() => false);

    const onnxFiles = [...ALLOWED_COMMAND_MODELS];
    const installedFiles = (
      await Promise.all(
        onnxFiles.map(async (f) => {
          const filePath = path.join(ONNX_DIR, f);
          try {
            const stat = await fs.stat(filePath);
            return stat.isFile() ? f : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean) as string[];

    const pointerFiles = (
      await Promise.all(
        installedFiles.map(async (f) =>
          (await isLfsPointer(path.join(ONNX_DIR, f))) ? f : null,
        ),
      )
    ).filter(Boolean) as string[];
    return c.json({ modelDirExists, onnxDirExists, onnxFiles, installedFiles, pointerFiles });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/commands/model", async (c) => {
  try {
    const { modelFile } = await c.req.json<{ modelFile: string }>();
    if (!modelFile || !isAllowedCommandModel(modelFile)) {
      return c.json({ error: `modelFile must be one of: ${ALLOWED_COMMAND_MODELS.join(", ")}` }, 400);
    }

    const raw = await fs.readFile(getRuntimePath(), "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const prev = (config.commands ?? {}) as Record<string, unknown>;
    config.commands = { ...prev, modelFile };
    await fs.writeFile(getRuntimePath(), JSON.stringify(config, null, 2));
    reloadRuntime();

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/commands/download-model", async (c) => {
  try {
    const { modelFile } = await c.req.json<{ modelFile: string }>();
    if (!modelFile || !isAllowedCommandModel(modelFile)) {
      return c.json({ error: `modelFile must be one of: ${ALLOWED_COMMAND_MODELS.join(", ")}` }, 400);
    }
    if (downloadState.active) {
      return c.json({ error: "Download already in progress" }, 409);
    }

    const dest = path.join(ONNX_DIR, modelFile);
    const tmp = dest + ".download";
    const url = `${HF_REPO}/resolve/main/onnx/${encodeURIComponent(modelFile)}`;
    const abortController = new AbortController();

    downloadState = { active: true, modelFile, downloaded: 0, total: 0, error: null, abortController };

    (async () => {
      let fileHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        const response = await fetch(url, { signal: abortController.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        downloadState.total = Number(response.headers.get("content-length") ?? 0);

        await fs.mkdir(ONNX_DIR, { recursive: true });
        fileHandle = await fs.open(tmp, "w");
        const writer = fileHandle.createWriteStream();

        const reader = response.body!.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await new Promise<void>((res, rej) => {
              writer.write(Buffer.from(value), (err) => (err ? rej(err) : res()));
            });
            downloadState.downloaded += value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }

        await new Promise<void>((res, rej) => {
          writer.end();
          writer.on("finish", res);
          writer.on("error", rej);
        });
        await fileHandle.close();

        // Atomically replace pointer with real model
        await fs.rename(tmp, dest);
        downloadState = { active: false, modelFile, downloaded: downloadState.downloaded, total: downloadState.total, error: null, abortController: null };
        logger.info("Model file downloaded", { modelFile });
      } catch (err: unknown) {
        if (fileHandle) await fileHandle.close().catch(() => {});
        // Only delete the temp file — leave the original pointer intact
        await fs.unlink(tmp).catch(() => {});
        const isAbort = (err as Error)?.name === "AbortError";
        if (!isAbort) {
          downloadState = { active: false, modelFile, downloaded: 0, total: 0, error: (err as Error).message, abortController: null };
          logger.error("Model download failed", { modelFile, error: (err as Error).message });
        } else {
          downloadState = { active: false, modelFile: null, downloaded: 0, total: 0, error: null, abortController: null };
        }
      }
    })();

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/commands/download-status", (c) => {
  const { abortController: _, ...publicState } = downloadState;
  return c.json(publicState);
});

app.post("/api/commands/download-cancel", (c) => {
  if (!downloadState.active || !downloadState.abortController) {
    return c.json({ error: "No active download" }, 400);
  }
  downloadState.abortController.abort();
  return c.json({ success: true });
});

// Start

export function startServer(): void {
  serve({ fetch: app.fetch, port: 3789 });
  logger.info("Dashboard running → http://localhost:3789");
}
