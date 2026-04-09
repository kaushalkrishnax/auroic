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
 *   POST /api/shell/exec                   — spawn a shell command
 *   POST /api/shell/stdin                  — send stdin to a running command
 *   GET  /api/shell/stream/:sessionId      — SSE stream for command output
 *   POST /api/shell/kill                   — kill a running process
 *   GET  /api/shell/cwd                    — get server working directory
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import logger from "@/utils/logger.js";
import { eventBus } from "@/events.js";
import { BOT_FBID, reloadConfig } from "@/runtime/index.js";
import {
  disconnectBrowser,
  initInstagramSession,
} from "@/automation/session.js";
import { runWithAutomationLock } from "@/automation/executionLock.js";
import {
  beginBrowserReload,
  endBrowserReload,
  getSystemControlState,
  pauseSystem,
  resumeSystem,
} from "@/runtime/systemControl.js";
import { classifyCommand, hasCommandTriggerKeyword } from "@/command/command.js";
import { getAllConversations } from "@/db/queries/conversations.js";
import { getLatestMessages } from "@/db/queries/messages.js";
import { getAllMessages } from "@/db/queries/messages.js";
import { getAllUsers } from "@/db/queries/users.js";
import { getAllMedia, getMediaForMessages } from "@/db/queries/media.js";
import { getAllReactions } from "@/db/queries/reactions.js";
import { getAllOutgoing } from "@/db/queries/outgoing.js";
import { insertOutgoing } from "@/db/queries/outgoing.js";
import { COMMAND_REGISTRY } from "@/command/commandRegistry.js";
import { executeAction } from "@/router/dispatcher.js";
import { sendText } from "@/automation/chat.js";
import { navigateToChat } from "@/automation/navigation.js";
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

// Shell sessions

type OutputEntry =
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; code: number };

interface ShellSession {
  id: string;
  process: ChildProcess;
  cwd: string;
  command: string;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  outputBuffer: OutputEntry[];
  /** All active SSE subscribers for this session (supports multiple tabs) */
  subscribers: Set<(entry: OutputEntry) => void>;
}

const shellSessions = new Map<string, ShellSession>();
const SERVER_CWD = process.cwd();

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
  let closed = false;

  const send = (event: AppEvent) => {
    if (closed) return;
    const data = `data: ${JSON.stringify(event)}\n\n`;
    writer.write(encoder.encode(data)).catch(() => cleanup());
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    eventBus.off("event", send);
    writer.close().catch((err) => {
      logger.debug("SSE writer close failed", {
        error: (err as Error).message,
      });
    });
  };

  eventBus.on("event", send);

  const heartbeat = setInterval(() => {
    if (closed) {
      clearInterval(heartbeat);
      return;
    }
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

// Data API─

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
    const rows = getAllMessages(chatId, limit);
    const mediaRows = getMediaForMessages(rows.map((row) => row.messageId));
    const mediaByMessageId = new Map<string, typeof mediaRows>();

    for (const mediaRow of mediaRows) {
      const bucket = mediaByMessageId.get(mediaRow.messageId) ?? [];
      bucket.push(mediaRow);
      mediaByMessageId.set(mediaRow.messageId, bucket);
    }

    return c.json(
      rows.map((row) => ({
        ...row,
        media: mediaByMessageId.get(row.messageId) ?? [],
      })),
    );
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

    if (!code) return c.json({ error: "code is required" }, 400);

    if (!isOtpPending()) {
      return c.json(
        { success: false, error: "Bot is not currently waiting for OTP" },
        400,
      );
    }

    const accepted = submitOtpCode(code);
    if (!accepted) {
      return c.json({ success: false, error: "Failed to submit OTP" }, 400);
    }

    return c.json({ success: true, message: "OTP submitted" });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/system/status", (c) => {
  try {
    return c.json(getSystemControlState());
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/system/control", async (c) => {
  try {
    const body = await c.req.json<{ action?: string }>();
    const action = String(body.action ?? "").trim().toLowerCase();

    if (!action) return c.json({ error: "action is required" }, 400);

    if (action === "pause") {
      const changed = pauseSystem("dashboard");
      return c.json({
        success: true,
        changed,
        state: getSystemControlState(),
        message: changed ? "System paused" : "System already paused",
      });
    }

    if (action === "resume") {
      const changed = resumeSystem("dashboard");
      return c.json({
        success: true,
        changed,
        state: getSystemControlState(),
        message: changed ? "System resumed" : "System already running",
      });
    }

    if (action === "reload-browser" || action === "restart") {
      const started = beginBrowserReload("dashboard");
      if (!started) {
        return c.json({
          success: false,
          state: getSystemControlState(),
          message: "Browser reload is already in progress",
        });
      }

      try {
        await runWithAutomationLock("reload-browser", "system", async () => {
          await disconnectBrowser();
          await initInstagramSession();
        });
        endBrowserReload("dashboard", true);
      } catch (reloadErr) {
        endBrowserReload("dashboard", false);
        throw reloadErr;
      }

      return c.json({
        success: true,
        state: getSystemControlState(),
        message: "Browser reloaded",
      });
    }

    return c.json({ error: `Unsupported action: ${action}` }, 400);
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

      sanitizedRows.push({
        command,
        aliases: (Array.isArray(row.aliases) ? row.aliases : [])
          .map((v) => String(v).trim().toLowerCase())
          .filter(Boolean),
        filterKeywords: (Array.isArray(row.filterKeywords)
          ? row.filterKeywords
          : []
        )
          .map((v) => String(v).trim().toLowerCase())
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
    const body = await c.req.json<{
      chatId?: string;
      command?: string;
      input?: string;
    }>();
    const chatId = String(body.chatId ?? "").trim();
    const rawInput = String(body.input ?? body.command ?? "").trim();

    if (!chatId) return c.json({ error: "chatId is required" }, 400);
    if (!rawInput) return c.json({ error: "input is required" }, 400);

    const canBeCommand = await hasCommandTriggerKeyword(rawInput);
    const classified = canBeCommand ? await classifyCommand(rawInput) : null;

    if (!classified) {
      const sent = await runWithAutomationLock(
        "dashboard-send-text",
        chatId,
        async () => {
          await initInstagramSession();
          await navigateToChat(chatId);
          return sendText(rawInput, chatId);
        },
      );

      insertOutgoing({
        conversationId: chatId,
        targetMessageId: null,
        actionType: "text",
        effortLevel: null,
        intentLabel: "dashboard-manual-text",
        messageContent: rawInput,
        executionStatus: sent ? "sent" : "failed",
        platformMessageId: null,
        executionError: sent ? null : "Failed to send dashboard text",
      });

      if (!sent) {
        return c.json(
          {
            success: false,
            mode: "text",
            error: "Failed to send text",
          },
          500,
        );
      }

      emitEvent({
        type: "OUTGOING",
        chatId,
        actionType: "text",
        content: rawInput,
      });

      return c.json({ success: true, mode: "text", resultText: rawInput });
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
      candidates: [rawInput],
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
          mode: "command",
          classifiedCommand: classified,
          error: executionError || "Command execution failed",
        },
        500,
      );
    }

    return c.json({
      success: true,
      mode: "command",
      classifiedCommand: classified,
      resultText,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Shell execution API

app.get("/api/shell/cwd", (c) => {
  return c.json({ cwd: SERVER_CWD });
});

app.post("/api/shell/exec", async (c) => {
  try {
    const body = await c.req.json<{ command?: string; cwd?: string }>();
    const command = String(body.command ?? "").trim();
    if (!command) return c.json({ error: "command is required" }, 400);

    const cwd = body.cwd?.trim() || SERVER_CWD;
    const sessionId = crypto.randomUUID();

    const child = spawn(command, {
      shell: "/bin/bash",
      cwd,
      env: { ...process.env, TERM: "dumb", COLUMNS: "200", LINES: "50" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const session: ShellSession = {
      id: sessionId,
      process: child,
      cwd,
      command,
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
      outputBuffer: [],
      subscribers: new Set(),
    };

    shellSessions.set(sessionId, session);

    const pushEntry = (entry: OutputEntry) => {
      session.outputBuffer.push(entry);
      for (const sub of session.subscribers) {
        try {
          sub(entry);
        } catch {
          /* ignore */
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      pushEntry({ type: "stdout", data: chunk.toString("utf-8") });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      pushEntry({ type: "stderr", data: chunk.toString("utf-8") });
    });

    child.on("exit", (code) => {
      session.exited = true;
      session.exitCode = code;
      pushEntry({ type: "exit", code: code ?? -1 });
      // Clean up after 60s so late-connecting streams can still replay
      setTimeout(() => shellSessions.delete(sessionId), 60_000);
    });

    child.on("error", (err) => {
      logger.warn("Shell process error", {
        sessionId,
        command,
        error: err.message,
      });
      if (!session.exited) {
        session.exited = true;
        session.exitCode = -1;
        pushEntry({ type: "exit", code: -1 });
      }
    });

    return c.json({ sessionId, cwd });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/api/shell/stream/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = shellSessions.get(sessionId);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  const send = (payload: OutputEntry) => {
    if (closed) return;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    writer.write(encoder.encode(data)).catch(() => cleanup());
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    session.subscribers.delete(send);
    writer.close().catch(() => {});
  };

  // Register as a live subscriber BEFORE replaying buffer
  session.subscribers.add(send);

  // Replay all buffered output in order
  for (const entry of session.outputBuffer) {
    send(entry);
  }

  // If already exited and we replayed all output including exit, unsubscribe soon
  if (session.exited) {
    setTimeout(cleanup, 500);
  }

  c.req.raw.signal.addEventListener("abort", cleanup);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

app.post("/api/shell/stdin", async (c) => {
  try {
    const body = await c.req.json<{ sessionId?: string; input?: string }>();
    const sessionId = String(body.sessionId ?? "").trim();
    const input = String(body.input ?? "");

    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);

    const session = shellSessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.exited)
      return c.json({ error: "Process has already exited" }, 400);

    if (!session.process.stdin || session.process.stdin.destroyed) {
      return c.json({ error: "stdin is not available" }, 400);
    }

    session.process.stdin.write(input);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/shell/kill", async (c) => {
  try {
    const body = await c.req.json<{ sessionId?: string; signal?: string }>();
    const sessionId = String(body.sessionId ?? "").trim();

    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);

    const session = shellSessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.exited) return c.json({ success: true, alreadyExited: true });

    const sig = (body.signal || "SIGINT") as NodeJS.Signals;
    try {
      // Kill the entire process group (covers child processes too)
      process.kill(-session.process.pid!, sig);
    } catch {
      session.process.kill(sig);
    }

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Start

export function startServer(): void {
  serve({
    fetch: app.fetch,
    port: process.env.PORT ? Number(process.env.PORT) : 7860,
    hostname: "0.0.0.0",
  });
  logger.info(
    `Dashboard running → http://localhost:${process.env.PORT ?? 7860}`,
  );
}
