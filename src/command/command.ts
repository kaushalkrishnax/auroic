import getConfig from "@/runtime/index.js";
import type { ActionType } from "@/types/index.js";
import logger from "@/utils/logger.js";
import {
  COMMAND_REGISTRY,
  getCommandHandler,
} from "@/command/commandRegistry.js";
import type { Page } from "playwright";

interface CommandSelection {
  commandName: string;
  actionType: ActionType;
  aliases: Set<string>;
  filterKeywords: Set<string>;
}

export interface ClassifiedCommand {
  commandName: string;
  actionType: ActionType;
  query: string;
  similarity: number;
}

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

function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function buildCandidates(): CommandSelection[] {
  const configRows = getConfig().commands.rows;

  return configRows
    .filter((row) => row.isEnabled)
    .map((row) => {
      const registryDef = registryByName.get(row.command);
      const actionType = asActionType(registryDef?.actionType ?? "text") ?? "text";

      const aliases = new Set(
        row.aliases.map((alias) => normalizeToken(alias)).filter(Boolean),
      );
      aliases.add(normalizeToken(row.command));

      const filterKeywords = new Set(
        row.filterKeywords.map((word) => normalizeToken(word)).filter(Boolean),
      );

      return {
        commandName: row.command,
        actionType,
        aliases,
        filterKeywords,
      };
    });
}

function deriveQuery(text: string, wordsToStrip: Set<string>): string {
  const tokens = text.split(/\s+/).filter(Boolean);

  const kept = tokens.filter((token) => {
    const normalized = normalizeToken(token);
    if (!normalized) return false;
    if (normalized === "bot") return false;
    return !wordsToStrip.has(normalized);
  });

  return kept.join(" ").trim();
}

function scoreCandidate(inputTokens: Set<string>, candidate: CommandSelection): number {
  let score = 0;
  for (const alias of candidate.aliases) {
    if (inputTokens.has(alias)) score += 1;
  }
  return score;
}

export async function hasCommandTriggerKeyword(text: string): Promise<boolean> {
  const normalizedInput = text.trim();
  if (!normalizedInput) return false;

  const tokens = new Set(
    normalizedInput
      .split(/\s+/)
      .map(normalizeToken)
      .filter(Boolean),
  );

  const candidates = buildCandidates();
  return candidates.some((candidate) => scoreCandidate(tokens, candidate) > 0);
}

export async function classifyCommand(text: string): Promise<ClassifiedCommand | null> {
  const config = getConfig().commands;
  if (!config.enabled) return null;

  const normalizedInput = text.trim();
  if (!normalizedInput) return null;

  const tokens = new Set(
    normalizedInput
      .split(/\s+/)
      .map(normalizeToken)
      .filter(Boolean),
  );

  const candidates = buildCandidates();

  let best: { candidate: CommandSelection; score: number } | null = null;
  for (const candidate of candidates) {
    const score = scoreCandidate(tokens, candidate);
    if (score > 0 && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }

  if (!best) return null;

  const stripWords = new Set<string>([
    ...config.queryFilterWords.map((word) => normalizeToken(word)),
    ...best.candidate.aliases,
    ...best.candidate.filterKeywords,
    ...best.candidate.commandName
      .toLowerCase()
      .split(/\s+/)
      .map((word) => normalizeToken(word))
      .filter(Boolean),
  ]);

  const query = deriveQuery(normalizedInput, stripWords);

  return {
    commandName: best.candidate.commandName,
    actionType: best.candidate.actionType,
    query,
    similarity: 1,
  };
}

export async function executeCommand(
  classified: ClassifiedCommand,
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

    await handler(classified.query, conversationId);

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
