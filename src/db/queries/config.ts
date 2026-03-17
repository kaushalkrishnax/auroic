import { eq } from "drizzle-orm";
import { getConfigDB } from "@/db/configDb.js";
import { commandsTable, settingsTable } from "@/db/configSchema.js";
import { COMMAND_REGISTRY } from "@/command/commandRegistry.js";
import logger from "@/utils/logger.js";

export interface RuntimeSettingsPayload {
  triggers: {
    mentions: string[];
    hashtags: string[];
    keywords?: string[];
    onReply?: boolean;
    passiveMonitoring?: {
      enabled: boolean;
      messageCount: number;
      timeThresholdMs: number;
      cooldownMs?: number;
    };
  };
  llm: {
    systemPrompt: string;
    timeout: number;
    models: { low: string; medium: string; high: string };
    output: { maxTokens: number };
  };
  router: {
    host: string;
    model: string;
    systemPrompt?: string;
    think?: boolean;
    options?: {
      temperature?: number;
      top_p?: number;
      top_k?: number;
      repeat_penalty?: number;
    };
  };
  debug: {
    logRouterWindow: boolean;
  };
  instagram: Record<string, unknown>;
  commands: {
    enabled?: boolean;
    queryFilterWords?: string[];
  };
}

export interface CommandConfigRow {
  command: string;
  aliases: string[];
  filterKeywords: string[];
  handlerName: string;
  isEnabled: boolean;
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettingsPayload = {
  triggers: {
    mentions: ["@auroic.ai", "@bot"],
    hashtags: ["#bot"],
    onReply: true,
    passiveMonitoring: {
      enabled: true,
      messageCount: 10,
      timeThresholdMs: 10000,
      cooldownMs: 5000,
    },
  },
  llm: {
    systemPrompt:
      "You are Auroic, a real participant in this group chat. Reply naturally like a friend, not an AI.\\n\\nRules:\\n- H1-H5 and C1-C3 are message indexes, not usernames\\n- Reply only about the target message's topic, nothing else\\n- No markdown, plain text only\\n- Keep it short unless detail is clearly needed\\n- Hinglish tone by default, match language if target is in another language",
    timeout: 30000,
    models: {
      low: "llama-3.1-8b-instant",
      medium: "meta-llama/llama-4-scout-17b-16e-instruct",
      high: "openai/gpt-oss-120b",
    },
    output: {
      maxTokens: 100,
    },
  },
  router: {
    host: "http://localhost:11434",
    model: "auroic-router-0.6b",
    systemPrompt:
      "You are the Auroic Router. Given history messages H1-H5 and candidate messages C1-C3, output exactly one routing decision.\\nAlways choose a decision for @BOT messages never ignore them.",
    think: true,
    options: {
      temperature: 0.5,
      top_p: 1.05,
      top_k: 20,
      repeat_penalty: 1.1,
    },
  },
  debug: {
    logRouterWindow: true,
  },
  instagram: {},
  commands: {
    enabled: true,
    queryFilterWords: [
      "gif",
      "gifs",
      "sticker",
      "stickers",
      "media",
      "meme",
      "memes",
      "image",
      "images",
    ],
  },
};

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values.map((value) => String(value).trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

function nowIso(): string {
  return new Date().toISOString();
}

function toCommandConfigRow(row: typeof commandsTable.$inferSelect): CommandConfigRow {
  return {
    command: row.command,
    aliases: normalizeList(row.aliases),
    filterKeywords: normalizeList(row.filterKeywords),
    handlerName: row.handlerName ?? "",
    isEnabled: row.isEnabled ?? true,
  };
}

export function getSettingsPayload(): RuntimeSettingsPayload {
  const db = getConfigDB();
  const row = db.select().from(settingsTable).where(eq(settingsTable.id, 1)).get();
  if (!row) return DEFAULT_RUNTIME_SETTINGS;

  return {
    triggers: (row.triggers as RuntimeSettingsPayload["triggers"]) ?? DEFAULT_RUNTIME_SETTINGS.triggers,
    llm: (row.llm as RuntimeSettingsPayload["llm"]) ?? DEFAULT_RUNTIME_SETTINGS.llm,
    router: (row.router as RuntimeSettingsPayload["router"]) ?? DEFAULT_RUNTIME_SETTINGS.router,
    debug: (row.debug as RuntimeSettingsPayload["debug"]) ?? DEFAULT_RUNTIME_SETTINGS.debug,
    instagram: (row.instagram as RuntimeSettingsPayload["instagram"]) ?? DEFAULT_RUNTIME_SETTINGS.instagram,
    commands: (row.commands as RuntimeSettingsPayload["commands"]) ?? DEFAULT_RUNTIME_SETTINGS.commands,
  };
}

export function upsertSettingsPayload(payload: RuntimeSettingsPayload): void {
  const db = getConfigDB();
  db
    .insert(settingsTable)
    .values({
      id: 1,
      triggers: payload.triggers,
      llm: payload.llm,
      router: payload.router,
      debug: payload.debug,
      instagram: payload.instagram,
      commands: payload.commands,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: {
        triggers: payload.triggers,
        llm: payload.llm,
        router: payload.router,
        debug: payload.debug,
        instagram: payload.instagram,
        commands: payload.commands,
        updatedAt: nowIso(),
      },
    })
    .run();
}

export function getCommandConfigs(): CommandConfigRow[] {
  const db = getConfigDB();
  const rows = db.select().from(commandsTable).all();
  return rows.map(toCommandConfigRow);
}

export function replaceCommandConfigs(rows: CommandConfigRow[]): void {
  const db = getConfigDB();
  db.delete(commandsTable).run();

  if (rows.length === 0) return;

  // Deduplicate aliases globally — first command to claim an alias wins
  const seenAliases = new Set<string>();
  const deduped = rows.map((row) => ({
    ...row,
    aliases: normalizeList(row.aliases).filter((alias) => {
      if (seenAliases.has(alias)) return false;
      seenAliases.add(alias);
      return true;
    }),
  }));

  db.insert(commandsTable)
    .values(
      deduped.map((row) => ({
        command: row.command,
        aliases: row.aliases,
        filterKeywords: normalizeList(row.filterKeywords),
        handlerName: row.handlerName,
        isEnabled: row.isEnabled,
        updatedAt: nowIso(),
      })),
    )
    .run();
}

export function ensureConfigSeeded(): void {
  const db = getConfigDB();

  const settingsCount = db.select({ id: settingsTable.id }).from(settingsTable).all().length;
  if (settingsCount === 0) {
    upsertSettingsPayload(DEFAULT_RUNTIME_SETTINGS);
  }

  const commandCount = db.select({ command: commandsTable.command }).from(commandsTable).all().length;
  if (commandCount > 0) return;

  replaceCommandConfigs(
    COMMAND_REGISTRY.map((entry) => ({
      command: entry.name,
      aliases: entry.commandWords,
      filterKeywords: entry.commandWords,
      handlerName: entry.handlerName,
      isEnabled: true,
    })),
  );
}

/**
 * Reconciles the commands table with COMMAND_REGISTRY on every startup.
 *
 * Rules:
 * - Commands removed from the registry are deleted from the DB.
 * - Commands added to the registry are inserted with defaults for editable fields.
 * - Editable fields (aliases, filterKeywords, isEnabled) are never overwritten.
 * - Non-editable field (handlerName) is kept in sync with the registry.
 */
export function syncCommandsWithRegistry(): void {
  const db = getConfigDB();

  const registryMap = new Map(COMMAND_REGISTRY.map((c) => [c.name, c]));
  const existingRows = db.select({ command: commandsTable.command }).from(commandsTable).all();
  const existingNames = new Set(existingRows.map((r) => r.command));

  // Delete rows whose commands no longer exist in the registry
  for (const { command } of existingRows) {
    if (!registryMap.has(command)) {
      db.delete(commandsTable).where(eq(commandsTable.command, command)).run();
      logger.info("Removed command from DB (deleted from registry)", { command });
    }
  }

  // Insert or update-non-editable-fields for registry commands
  for (const entry of COMMAND_REGISTRY) {
    if (!existingNames.has(entry.name)) {
      // New command: insert with registry values as defaults for editable fields
      db
        .insert(commandsTable)
        .values({
          command: entry.name,
          aliases: entry.commandWords,
          filterKeywords: entry.commandWords,
          handlerName: entry.handlerName,
          isEnabled: true,
          updatedAt: nowIso(),
        })
        .run();
      logger.info("Added command to DB from registry", { command: entry.name });
    } else {
      // Existing command: only update the non-editable handlerName
      db
        .update(commandsTable)
        .set({ handlerName: entry.handlerName, updatedAt: nowIso() })
        .where(eq(commandsTable.command, entry.name))
        .run();
    }
  }
}
