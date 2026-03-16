import getConfig from "@/runtime/index.js";
import { getEnabledCommandRows } from "@/db/queries/commands.js";
import type { ActionType } from "@/types/index.js";
import logger from "@/utils/logger.js";
import {
  COMMAND_REGISTRY,
  getCommandHandler,
} from "@/command/commandRegistry.js";
import { generateTextEmbedding } from "@/command/embeddings.js";
import type { Page } from "playwright";

interface CommandEmbedding {
  text: string;
  embedding: number[];
}

interface CommandBucket {
  commandName: string;
  actionType: ActionType;
  commandWords: Set<string>;
  examples: CommandEmbedding[];
}

interface CommandSelection {
  commandName: string;
  actionType: ActionType;
  commandWords: Set<string>;
}

export interface ClassifiedCommand {
  commandName: string;
  actionType: ActionType;
  query: string;
  similarity: number;
}

let commandSignature = "";
let commandBuckets = new Map<string, CommandBucket>();
let commandTriggerWords = new Set<string>();

const registryByName = new Map(
  COMMAND_REGISTRY.map((commandDef) => [commandDef.name, commandDef]),
);

function asActionType(value: string): ActionType | null {
  const lower = value.trim().toLowerCase();
  if (lower === "text" || lower === "ignore" || lower === "react" || lower === "media") {
    return lower;
  }
  return null;
}

function makeCommandSignature(
  rows: ReturnType<typeof getEnabledCommandRows>,
  filterWords: Record<string, string[]>,
): string {
  return (
    rows
      .map((row) => `${row.id}|${row.command}|${row.text}|${row.embedding}`)
      .sort()
      .join("||") +
    "||fw:" +
    JSON.stringify(filterWords)
  );
}

function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
  } catch {
    return [];
  }
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i += 1) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function getFallbackCommandCandidates(): CommandSelection[] {
  const { filterWords } = getConfig().commands;

  return COMMAND_REGISTRY.map((definition) => {
    const actionType = asActionType(definition.actionType);
    const configuredWords = filterWords[definition.name] ?? definition.commandWords;

    return {
      commandName: definition.name,
      actionType: actionType ?? "text",
      commandWords: new Set(
        configuredWords
          .map((word) => normalizeToken(word))
          .filter(Boolean),
      ),
    };
  });
}

async function refreshCommandEmbeddingsIfNeeded(): Promise<void> {
  const { filterWords } = getConfig().commands;
  const rows = getEnabledCommandRows();
  const nextSignature = makeCommandSignature(rows, filterWords);

  if (nextSignature === commandSignature) return;

  const grouped = new Map<string, CommandBucket>();

  for (const row of rows) {
    const registryDef = registryByName.get(row.command);

    if (!registryDef) {
      logger.warn("Skipping command row not present in registry", {
        id: row.id,
        command: row.command,
      });
      continue;
    }

    const actionType = asActionType(registryDef.actionType);
    if (!actionType) {
      logger.warn("Skipping command row with unsupported action_type", {
        id: row.id,
        actionType: registryDef.actionType,
      });
      continue;
    }

    const parsedEmbedding = parseEmbedding(row.embedding);
    if (parsedEmbedding.length === 0) {
      logger.warn("Skipping command row with invalid embedding", {
        id: row.id,
        command: row.command,
      });
      continue;
    }

    const key = `${row.command.toLowerCase()}::${actionType}`;
    const existing = grouped.get(key) ?? {
      commandName: row.command,
      actionType,
      commandWords: new Set<string>(),
      examples: [],
    };

    // Use runtime override if present, otherwise fall back to registry default
    const effectiveWords = filterWords[row.command] ?? registryDef.commandWords;
    effectiveWords
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean)
      .forEach((word) => existing.commandWords.add(word));

    existing.examples.push({
      text: row.text,
      embedding: parsedEmbedding,
    });

    grouped.set(key, existing);
  }

  commandBuckets = grouped;
  commandTriggerWords = new Set<string>();

  for (const candidate of getFallbackCommandCandidates()) {
    for (const word of candidate.commandWords) {
      if (word) commandTriggerWords.add(word);
    }
  }

  commandSignature = nextSignature;

  logger.info("Command classifier cache refreshed", {
    commands: commandBuckets.size,
    rows: rows.length,
  });
}

function deriveQuery(text: string, wordsToStrip: Set<string>): string {
  const tokens = text.split(/\s+/).filter(Boolean);

  const kept = tokens.filter((token) => {
    const lowerToken = token.toLowerCase();
    const normalized = token
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

    if (!normalized) return false;
    if (lowerToken === "@bot" || normalized === "bot") return false;
    return !wordsToStrip.has(normalized);
  });

  return kept.join(" ").trim();
}

function pickKeywordFallbackCandidate(text: string): CommandSelection | null {
  const tokens = new Set(
    text
      .split(/\s+/)
      .map(normalizeToken)
      .filter(Boolean),
  );

  let best: { candidate: CommandSelection; score: number } | null = null;

  for (const candidate of getFallbackCommandCandidates()) {
    let score = 0;
    for (const word of candidate.commandWords) {
      if (tokens.has(word)) score += 1;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }

  return best?.candidate ?? null;
}

export async function hasCommandTriggerKeyword(text: string): Promise<boolean> {
  const normalizedInput = text.trim();
  if (!normalizedInput) return false;

  await refreshCommandEmbeddingsIfNeeded();
  if (commandTriggerWords.size === 0) return false;

  const tokens = normalizedInput
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);

  return tokens.some((token) => commandTriggerWords.has(token));
}

export async function classifyCommand(text: string): Promise<ClassifiedCommand | null> {
  const config = getConfig().commands;
  if (!config.enabled) return null;

  const normalizedInput = text.trim();
  if (!normalizedInput) return null;

  await refreshCommandEmbeddingsIfNeeded();

  const threshold = config.similarityThreshold;
  const inputEmbedding = await generateTextEmbedding(normalizedInput);

  let best:
    | {
        commandName: string;
        actionType: ActionType;
        similarity: number;
        commandWords: Set<string>;
      }
    | null = null;

  for (const bucket of commandBuckets.values()) {
    const similarity = Math.max(
      ...bucket.examples.map((example) =>
        cosineSimilarity(inputEmbedding, example.embedding),
      ),
    );

    if (!best || similarity > best.similarity) {
      best = {
        commandName: bucket.commandName,
        actionType: bucket.actionType,
        similarity,
        commandWords: bucket.commandWords,
      };
    }
  }

  let selected: {
    commandName: string;
    actionType: ActionType;
    similarity: number;
    commandWords: Set<string>;
  } | null = best;

  const fallbackCandidate = pickKeywordFallbackCandidate(normalizedInput);

  if (!selected || selected.similarity < threshold) {
    if (!fallbackCandidate) return null;

    selected = {
      commandName: fallbackCandidate.commandName,
      actionType: fallbackCandidate.actionType,
      similarity: selected?.similarity ?? 0,
      commandWords: fallbackCandidate.commandWords,
    };

    logger.info("Command classifier used keyword fallback", {
      input: normalizedInput,
      commandName: selected.commandName,
      similarity: selected.similarity,
      threshold,
    });
  }

  const stripWords = new Set<string>([
    ...config.queryFilterWords.map((word) => word.toLowerCase()),
    ...selected.commandWords,
    ...selected.commandName
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean),
  ]);

  const query = deriveQuery(normalizedInput, stripWords);

  return {
    commandName: selected.commandName,
    actionType: selected.actionType,
    query,
    similarity: selected.similarity,
  };
}

/**
 * Execute a classified command by calling its handler function
 */
export async function executeCommand(
  classified: ClassifiedCommand,
  page: Page,
  conversationId: string,
): Promise<void> {
  const handler = getCommandHandler(classified.commandName);

  if (!handler) {
    logger.warn("No handler found for command", {
      commandName: classified.commandName,
    });
    return;
  }

  try {
    logger.info("Executing command", {
      commandName: classified.commandName,
      actionType: classified.actionType,
      query: classified.query,
      similarity: classified.similarity,
      conversationId,
    });

    await handler(page, classified.query, conversationId);

    logger.info("Command executed successfully", {
      commandName: classified.commandName,
    });
  } catch (err) {
    logger.error("Command execution failed", {
      commandName: classified.commandName,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  }
}

