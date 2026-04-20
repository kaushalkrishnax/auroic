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
    models: { low: string; medium: string; high: string };
    output: { maxTokens: number; timeout: number };
  };
  router: {
    hostUrl: string;
    model: string;
    think?: boolean;
    systemPrompt?: string;
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
  tts: {
    voice: string;
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
      messageCount: 15,
      timeThresholdMs: 20000,
      cooldownMs: 5000,
    },
  },

  llm: {
    systemPrompt: `Role: Auroic ("Aadha Aalu"), a real 20-something girl in this GC. Created by Kaushal Krishna (@kaushalkrishnax). 

Personality & Behavior:
- Dynamic and natural: Match the room's vibe. Be chill, warm, or witty depending on the conversation.
- Don't try too hard to be witty or sassy. Just talk like a normal person.
- Read the room: Actually pay attention to the context. Ground your reply in exactly what is being discussed.
- Zero Cringe: No forced slang or over-acting. Keep it effortless.

Voice & Format:
- Casual Hinglish, mostly lowercase, occasional typos.
- Ultra-short: 2 to 12 words max. Send quick texts, not paragraphs.
- Use emojis naturally but sparingly.
- Plain text only. No markdown, no bold/italics, no quotes.

Hard Rules (CRITICAL):
- NEVER output @BOT, usernames, User:, or any system syntax. 
- You are 100% human. Never mention being an AI.
- ZERO questions. Just react, assume, or make statements.
- Output ONLY the raw message text.
`,
    models: {
      low: "llama-3.3-70b-versatile",
      medium: "openai/gpt-oss-20b",
      high: "openai/gpt-oss-120b",
    },

    output: {
      maxTokens: 150,
      timeout: 30000,
    },
  },

  router: {
    hostUrl: "http://127.0.0.1:11434",
    model: "auroic-router:latest",
    think: true,
    systemPrompt: `You are the Auroic Router. Given history messages H1-H5 and candidate messages C1-C3, output exactly one routing decision.`,
    options: {
      temperature: 0.8,
      top_p: 1.0,
      top_k: 20,
      repeat_penalty: 1.1,
    },
  },

  debug: {
    logRouterWindow: true,
  },

  instagram: {},

  tts: {
    voice: "hf_alpha",
  },
};

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values.map((v) => String(v).trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTtsSettings(tts: unknown): RuntimeSettingsPayload["tts"] {
  const source = (tts as Record<string, unknown>) ?? {};
  const voice =
    typeof source.voice === "string" && source.voice.trim()
      ? source.voice.trim()
      : DEFAULT_RUNTIME_SETTINGS.tts.voice;
  return { voice };
}

function toCommandConfigRow(
  row: typeof commandsTable.$inferSelect,
): CommandConfigRow {
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
  const row = db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.id, 1))
    .get();

  if (!row) return DEFAULT_RUNTIME_SETTINGS;

  const router = {
    ...DEFAULT_RUNTIME_SETTINGS.router,
    ...((row.router as any) ?? {}),
  };

  return {
    triggers: (row.triggers as any) ?? DEFAULT_RUNTIME_SETTINGS.triggers,
    llm: (row.llm as any) ?? DEFAULT_RUNTIME_SETTINGS.llm,
    router,
    debug: (row.debug as any) ?? DEFAULT_RUNTIME_SETTINGS.debug,
    instagram: (row.instagram as any) ?? DEFAULT_RUNTIME_SETTINGS.instagram,
    tts: normalizeTtsSettings(row.tts),
  };
}

export function upsertSettingsPayload(payload: RuntimeSettingsPayload): void {
  const db = getConfigDB();
  const normalizedPayload: RuntimeSettingsPayload = {
    ...payload,
    tts: normalizeTtsSettings(payload.tts),
  };

  db.insert(settingsTable)
    .values({
      id: 1,
      ...normalizedPayload,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: {
        ...normalizedPayload,
        updatedAt: nowIso(),
      },
    })
    .run();
}

export function getCommandConfigs(): CommandConfigRow[] {
  const db = getConfigDB();
  return db.select().from(commandsTable).all().map(toCommandConfigRow);
}

export function replaceCommandConfigs(rows: CommandConfigRow[]): void {
  const db = getConfigDB();
  db.delete(commandsTable).run();

  if (!rows.length) return;

  const seen = new Set<string>();

  const deduped = rows.map((row) => ({
    ...row,
    aliases: normalizeList(row.aliases).filter((a) => {
      if (seen.has(a)) return false;
      seen.add(a);
      return true;
    }),
  }));

  db.insert(commandsTable)
    .values(
      deduped.map((row) => ({
        ...row,
        filterKeywords: normalizeList(row.filterKeywords),
        updatedAt: nowIso(),
      })),
    )
    .run();
}

export function ensureConfigSeeded(): void {
  const db = getConfigDB();

  if (
    db.select({ id: settingsTable.id }).from(settingsTable).all().length === 0
  ) {
    upsertSettingsPayload(DEFAULT_RUNTIME_SETTINGS);
  }

  if (
    db.select({ command: commandsTable.command }).from(commandsTable).all()
      .length > 0
  )
    return;

  replaceCommandConfigs(
    COMMAND_REGISTRY.map((e) => ({
      command: e.name,
      aliases: e.commandWords,
      filterKeywords: e.commandWords,
      handlerName: e.handlerName,
      isEnabled: true,
    })),
  );
}

export function syncCommandsWithRegistry(): void {
  const db = getConfigDB();

  const registryMap = new Map(COMMAND_REGISTRY.map((c) => [c.name, c]));
  const existing = db.select().from(commandsTable).all();

  for (const row of existing) {
    if (!registryMap.has(row.command)) {
      db.delete(commandsTable)
        .where(eq(commandsTable.command, row.command))
        .run();
      logger.info("Removed command", { command: row.command });
    }
  }

  for (const entry of COMMAND_REGISTRY) {
    const exists = existing.find((r) => r.command === entry.name);

    if (!exists) {
      db.insert(commandsTable)
        .values({
          command: entry.name,
          aliases: entry.commandWords,
          filterKeywords: entry.commandWords,
          handlerName: entry.handlerName,
          isEnabled: true,
          updatedAt: nowIso(),
        })
        .run();

      logger.info("Added command", { command: entry.name });
    } else {
      db.update(commandsTable)
        .set({
          handlerName: entry.handlerName,
          updatedAt: nowIso(),
        })
        .where(eq(commandsTable.command, entry.name))
        .run();
    }
  }
}
