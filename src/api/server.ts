/**
 * Hono HTTP server.
 *
 * Routes:
 *   GET  /                       — live dashboard HTML
 *   GET  /events                 — SSE stream (real-time events)
 *   GET  /config                 — read settings from config.db
 *   POST /config                 — write settings to config.db
 *   GET  /api/conversations              — all conversations
 *   GET  /api/conversations/:id/messages — messages for a chat
 *   GET  /api/messages           — all messages (recent)
 *   GET  /api/users              — all users
 *   GET  /api/media              — recent media
 *   GET  /api/reactions          — recent reactions
 *   GET  /api/outgoing           — outgoing message log
 *   GET  /api/commands                     — all command config rows
 *   GET  /api/commands/registry            — available registry command names
 *   POST /api/commands/save                — save command table edits
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import logger from "@/utils/logger.js";
import { eventBus } from "@/events.js";
import { BOT_FBID, reloadConfig } from "@/runtime/index.js";
import { classifyCommand } from "@/command/command.js";
import { getAllConversations } from "@/db/queries/conversations.js";
import { getLatestMessages } from "@/db/queries/messages.js";
import { getAllMessages } from "@/db/queries/messages.js";
import { getAllUsers } from "@/db/queries/users.js";
import { getAllMedia } from "@/db/queries/media.js";
import { getAllReactions } from "@/db/queries/reactions.js";
import { getAllOutgoing } from "@/db/queries/outgoing.js";
import { insertOutgoing } from "@/db/queries/outgoing.js";
import { COMMAND_REGISTRY } from "@/command/commandRegistry.js";
import { executeAction } from "@/router/dispatcher.js";
import { emitEvent } from "@/events.js";
import {
  getOtpPendingRequestedAt,
  isOtpPending,
  submitOtpCode,
} from "@/automation/session.js";
import {
  getCommandConfigs,
  getSettingsPayload,
  replaceCommandConfigs,
  upsertSettingsPayload,
  type CommandConfigRow,
  type RuntimeSettingsPayload,
} from "@/db/queries/config.js";
import { getKokoroTtsOptions } from "@/runtime/tts.js";
import type { AppEvent } from "@/events.js";
import type { ActionContext, Message } from "@/types/index.js";

// Paths

const DASHBOARD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dashboard/index.html",
);

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
    writer.close().catch((err) => {
      logger.debug("SSE writer close failed", {
        error: (err as Error).message,
      });
    });
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
    const settings = getSettingsPayload();
    const config: Record<string, unknown> = { ...settings };
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

    const existing = getSettingsPayload();
    const merged = {
      ...existing,
      ...body,
    } as unknown as RuntimeSettingsPayload;
    upsertSettingsPayload(merged);
    reloadConfig();
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
    return c.json(getCommandConfigs());
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
        aliases: commandDef.commandWords,
        handlerName: commandDef.handler.name,
      })),
    );
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/tts/options", async (c) => {
  try {
    return c.json(await getKokoroTtsOptions());
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/otp/status", (c) => {
  try {
    return c.json({
      pending: isOtpPending(),
      requestedAt: getOtpPendingRequestedAt(),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/otp/submit", async (c) => {
  try {
    const body = await c.req.json<{ code?: string }>();
    const code = String(body.code ?? "").trim();

    if (!code) {
      return c.json({ error: "code is required" }, 400);
    }

    if (!isOtpPending()) {
      return c.json(
        { success: false, error: "Bot is not currently waiting for OTP" },
        400,
      );
    }

    const accepted = submitOtpCode(code);
    if (!accepted) {
      return c.json(
        { success: false, error: "Failed to submit OTP" },
        400,
      );
    }

    return c.json({ success: true, message: "OTP submitted" });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/commands/save", async (c) => {
  try {
    const body = await c.req.json<{ commands: CommandConfigRow[] }>();
    if (!Array.isArray(body.commands)) {
      return c.json({ error: "commands must be an array" }, 400);
    }

    const validCommandNames = new Set(
      COMMAND_REGISTRY.map((entry) => entry.name),
    );
    const sanitizedRows: CommandConfigRow[] = [];

    for (const row of body.commands) {
      const command = String(row.command ?? "").trim();
      if (!command || !validCommandNames.has(command)) {
        return c.json(
          { error: `Invalid command: ${command || "(empty)"}` },
          400,
        );
      }

      const aliases = Array.isArray(row.aliases) ? row.aliases : [];
      const filterKeywords = Array.isArray(row.filterKeywords)
        ? row.filterKeywords
        : [];

      sanitizedRows.push({
        command,
        aliases: aliases
          .map((value) => String(value).trim().toLowerCase())
          .filter(Boolean),
        filterKeywords: filterKeywords
          .map((value) => String(value).trim().toLowerCase())
          .filter(Boolean),
        isEnabled: Boolean(row.isEnabled),
        handlerName: String(row.handlerName ?? ""),
      });
    }

    replaceCommandConfigs(sanitizedRows);
    reloadConfig();
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/commands/execute", async (c) => {
  try {
    const body = await c.req.json<{ chatId?: string; command?: string }>();
    const chatId = String(body.chatId ?? "").trim();
    const rawCommand = String(body.command ?? "").trim();

    if (!chatId) {
      return c.json({ error: "chatId is required" }, 400);
    }

    if (!rawCommand) {
      return c.json({ error: "command is required" }, 400);
    }

    const classified = await classifyCommand(rawCommand);
    if (!classified) {
      return c.json({ error: "No matching command found" }, 400);
    }

    const latest = getLatestMessages(chatId, 1, true);
    const targetMessage = latest[latest.length - 1];

    if (!targetMessage) {
      return c.json(
        { error: "No message context found for this conversation" },
        404,
      );
    }

    const decision = {
      type: classified.actionType,
      target: "C1",
      effort: classified.actionType === "text" ? "medium" : null,
      title: classified.query || classified.commandName,
      reason: `Dashboard command (${classified.commandName})`,
    } as const;

    const context: ActionContext = {
      chatId,
      message: targetMessage as Message,
      history: [],
      candidates: [rawCommand],
      decision,
      targetMessageId: targetMessage.messageId,
      targetTextContent: targetMessage.textContent,
      classifiedCommand: classified,
    };

    let resultText: string | null = null;
    let executionError: string | null = null;

    try {
      resultText = await executeAction(context);
    } catch (err) {
      executionError = (err as Error).message;
      logger.error("Dashboard command execution failed", {
        chatId,
        commandName: classified.commandName,
        error: executionError,
      });
    }

    insertOutgoing({
      conversationId: chatId,
      targetMessageId: targetMessage.messageId,
      actionType: decision.type,
      effortLevel: decision.effort,
      intentLabel: decision.title,
      messageContent: resultText,
      executionStatus: resultText !== null ? "sent" : "failed",
      platformMessageId: null,
      executionError,
    });

    emitEvent({
      type: "OUTGOING",
      chatId,
      actionType: decision.type,
      content: resultText,
    });

    if (resultText === null) {
      return c.json(
        {
          success: false,
          classifiedCommand: classified,
          error: executionError || "Command execution failed",
        },
        500,
      );
    }

    return c.json({
      success: true,
      classifiedCommand: classified,
      resultText,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Start

export function startServer(): void {
  serve({
    fetch: app.fetch,
    port: process.env.PORT ? Number(process.env.PORT) : 7860,
    hostname: "0.0.0.0"
  });
  logger.info(
    `Dashboard running → http://localhost:${process.env.PORT ?? 7860}`,
  );
}
