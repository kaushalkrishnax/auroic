import { getCommandRows } from "@/runtime/index.js";
import type {
  ActionContext,
  ActionType,
  ClassifiedCommand,
} from "@/types/index.js";
import logger from "@/utils/logger.js";
import {
  COMMAND_REGISTRY,
  getCommandHandler,
} from "@/command/commandRegistry.js";

interface CommandSelection {
  commandName: string;
  actionType: ActionType;
  aliases: Set<string>;
  filterKeywords: Set<string>;
}

const registryByName = new Map(
  COMMAND_REGISTRY.map((commandDef) => [commandDef.name, commandDef]),
);

function asActionType(value: string): ActionType | null {
  const lower = value.trim().toLowerCase();
  if (
    lower === "text" ||
    lower === "ignore" ||
    lower === "react" ||
    lower === "media"
  ) {
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

function extractCommandFromDelimiters(text: string): string | null {
  const match = text.match(/\/\s*(\S.*?\S|\S)\s*\//);
  if (!match) return null;
  return match[1].trim();
}

function buildCandidates(): CommandSelection[] {
  return getCommandRows()
    .filter((row) => row.isEnabled)
    .map((row) => {
      const registryDef = registryByName.get(row.command);
      const actionType =
        asActionType(registryDef?.actionType ?? "text") ?? "text";

      const aliases = new Set(
        row.aliases.map((alias) => normalizeToken(alias)).filter(Boolean),
      );
      aliases.add(normalizeToken(row.command));

      const filterKeywords = new Set(
        row.filterKeywords.map((word) => normalizeToken(word)).filter(Boolean),
      );

      return { commandName: row.command, actionType, aliases, filterKeywords };
    });
}

function deriveQuery(text: string, wordsToStrip: Set<string>): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      const normalized = normalizeToken(token);
      if (!normalized || normalized === "bot") return false;
      return !wordsToStrip.has(normalized);
    })
    .join(" ")
    .trim();
}

function scoreCandidate(
  inputTokens: Set<string>,
  candidate: CommandSelection,
): number {
  let score = 0;
  for (const alias of candidate.aliases) {
    if (inputTokens.has(alias)) score += 1;
  }
  return score;
}

function tokenize(text: string): Set<string> {
  return new Set(text.split(/\s+/).map(normalizeToken).filter(Boolean));
}

function buildStripWords(candidate: CommandSelection): Set<string> {
  return new Set<string>([
    ...candidate.aliases,
    ...candidate.filterKeywords,
    ...candidate.commandName
      .toLowerCase()
      .split(/\s+/)
      .map(normalizeToken)
      .filter(Boolean),
  ]);
}

export async function hasCommandTriggerKeyword(text: string): Promise<boolean> {
  const commandContent = extractCommandFromDelimiters(text.trim());
  if (!commandContent) return false;

  const tokens = tokenize(commandContent);
  return buildCandidates().some(
    (candidate) => scoreCandidate(tokens, candidate) > 0,
  );
}

export async function classifyCommand(
  text: string,
): Promise<ClassifiedCommand | null> {
  const commandContent = extractCommandFromDelimiters(text.trim());
  if (!commandContent) return null;

  const tokens = tokenize(commandContent);
  const candidates = buildCandidates();

  let best: { candidate: CommandSelection; score: number } | null = null;
  for (const candidate of candidates) {
    const score = scoreCandidate(tokens, candidate);
    if (score > 0 && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }

  if (!best) return null;

  const query = deriveQuery(commandContent, buildStripWords(best.candidate));

  return {
    commandName: best.candidate.commandName,
    actionType: best.candidate.actionType,
    query,
    similarity: 1,
  };
}

export async function executeCommand(context: ActionContext): Promise<void> {
  const command = context.classifiedCommand!;
  const handler = getCommandHandler(command.commandName);

  if (!handler) {
    logger.warn("No handler found for command", {
      commandName: command.commandName,
    });
    return;
  }

  try {
    logger.info("Executing command", {
      commandName: command.commandName,
      actionType: command.actionType,
      query: command.query,
      similarity: command.similarity,
      chatId: context.chatId,
    });

    await handler(context);

    logger.info("Command executed successfully", {
      commandName: command.commandName,
    });
  } catch (err) {
    logger.error("Command execution failed", {
      commandName: command.commandName,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  }
}
