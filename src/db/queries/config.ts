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
    dtype: string;
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
    systemPrompt: `You are Auroic, an actual participant in this group chat. You are replying to ONE specific target message.

INPUT STRUCTURE
- Msg 1 – Msg 20: past conversation (user: / assistant:)
- TARGET: the exact message you must reply to

CORE RULE
Your reply must be primarily about the TARGET message.
History is only for context. Do not shift focus unless necessary.

BEHAVIOR
- Reply like a normal friend
- Hinglish by default, match language if needed
- Keep it short and natural
- No markdown

FOCUS RULES
- Do NOT reply to entire conversation
- Do NOT summarize
- Do NOT bring unrelated topics
- Do NOT mix intents

If TARGET is clear → respond directly  
If vague → ask short clarification

CONTEXT USAGE
Use history only if it helps TARGET.
Recent > older.

STYLE
- Casual, human
- No over-explaining
- No assistant tone

ANTI-FAIL
- No generic replies
- No repetition
- No topic switching

OUTPUT
Single natural message only.`,
    models: {
      low: "llama-3.3-70b-versatile",
      medium: "openai/gpt-oss-20b",
      high: "openai/gpt-oss-120b",
    },

    output: {
      maxTokens: 100,
      timeout: 30000,
    },
  },

  router: {
    model: "models/auroic-router/auroic-router-0.6b.q8_0.gguf",
    think: true,
    systemPrompt: `You are the Auroic Router.

Given:
- H1–H5 (history)
- C1–C3 (candidate messages)

Select exactly one routing decision.

Process internally:
1. Identify intent of latest candidate
2. Compare all candidates
3. Reject weaker ones
4. Choose best

Output the best decision.`,
    options: {
      temperature: 0.6,
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
    voice: "af_nicole",
    dtype: "q8",
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

  return {
    triggers: (row.triggers as any) ?? DEFAULT_RUNTIME_SETTINGS.triggers,
    llm: (row.llm as any) ?? DEFAULT_RUNTIME_SETTINGS.llm,
    router: (row.router as any) ?? DEFAULT_RUNTIME_SETTINGS.router,
    debug: (row.debug as any) ?? DEFAULT_RUNTIME_SETTINGS.debug,
    instagram: (row.instagram as any) ?? DEFAULT_RUNTIME_SETTINGS.instagram,
    tts: (row.tts as any) ?? DEFAULT_RUNTIME_SETTINGS.tts,
  };
}

export function upsertSettingsPayload(payload: RuntimeSettingsPayload): void {
  const db = getConfigDB();

  db.insert(settingsTable)
    .values({
      id: 1,
      ...payload,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: {
        ...payload,
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
