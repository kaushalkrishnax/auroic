/**
 * Message processing pipeline.
 *
 * Event-driven: called when a NEW_MESSAGE or EDIT event arrives.
 *
 * Per-conversation state mirrors the in-memory batching model:
 *   - history: last 5 processed user/assistant pairs
 *   - candidates: waiting messages to process
 *   - batchTimeout: up-to-2s flush timer
 *   - hard limit: process immediately when queue reaches 3
 */

import { getMessageByMid, getLatestMessages } from "@/db/queries/messages.js";
import { insertOutgoing } from "@/db/queries/outgoing.js";
import { getConversationById } from "@/db/queries/conversations.js";
import { attachDataMidToDOM, stampInitialDataMids } from "@/automation/chat.js";
import { initInstagramSession } from "@/automation/session.js";
import { navigateToChat } from "@/automation/navigation.js";
import { invokeRouter } from "@/router/router.js";
import {
  classifyCommand,
  hasCommandTriggerKeyword,
} from "@/command/command.js";
import { executeAction } from "@/router/dispatcher.js";
import { runWithAutomationLock } from "@/automation/executionLock.js";
import { emitEvent } from "@/events.js";
import logger from "@/utils/logger.js";
import getConfig from "@/runtime/index.js";
import type {
  ActionContext,
  ClassifiedCommand,
  Message,
  RouterDecision,
} from "@/types/index.js";

interface ConversationHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

interface QueuedCandidate {
  messageId: string;
  content: string;
  queuedAtMs: number;
}

interface CandidateContentResult {
  content: string;
  isDirectMention: boolean;
}

interface ConversationState {
  history: ConversationHistoryEntry[];
  candidates: QueuedCandidate[];
  batchTimeout: ReturnType<typeof setTimeout> | null;
  processing: boolean;
  unprocessedMids: Set<string>;
  passiveFlushTimer: ReturnType<typeof setTimeout> | null;
  passiveProcessing: boolean;
  lastTouchedAt: number;
}

const conversationStates = new Map<string, ConversationState>();

const BATCH_TIMEOUT_MS = 2000;
const BATCH_HARD_LIMIT = 3;
const MAX_MESSAGE_AGE_MS = 20_000;
const CANDIDATE_SIZE = 3;
const HISTORY_SIZE = 5;
const STATE_IDLE_TTL_MS = 30 * 60 * 1000;
const STATE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const stateSweepInterval = setInterval(() => {
  const now = Date.now();

  for (const [chatId, state] of conversationStates.entries()) {
    const idleMs = now - state.lastTouchedAt;
    const hasTimers = Boolean(state.batchTimeout || state.passiveFlushTimer);
    const isBusy = state.processing || state.passiveProcessing;

    if (idleMs <= STATE_IDLE_TTL_MS || hasTimers || isBusy) {
      continue;
    }

    if (state.batchTimeout) {
      clearTimeout(state.batchTimeout);
      state.batchTimeout = null;
    }
    if (state.passiveFlushTimer) {
      clearTimeout(state.passiveFlushTimer);
      state.passiveFlushTimer = null;
    }

    conversationStates.delete(chatId);
    logger.info("Evicted idle conversation runtime state", { chatId, idleMs });
  }
}, STATE_SWEEP_INTERVAL_MS);

if (typeof stateSweepInterval.unref === "function") {
  stateSweepInterval.unref();
}

// Trigger detection

interface TriggerResult {
  triggered: boolean;
  match: string | null;
}

function detectTrigger(
  text: string,
  config: ReturnType<typeof getConfig>,
): TriggerResult {
  const lower = text.toLowerCase();
  const triggers = config.triggers;

  for (const mention of triggers.mentions ?? []) {
    if (lower.includes(mention.toLowerCase())) {
      return { triggered: true, match: mention };
    }
  }

  for (const hashtag of triggers.hashtags ?? []) {
    if (lower.includes(hashtag.toLowerCase())) {
      return { triggered: true, match: hashtag };
    }
  }

  return { triggered: false, match: null };
}

// @BOT replacement

function applyBotTag(text: string, triggerMatch: string): string {
  return text
    .replace(
      new RegExp(triggerMatch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      "@BOT",
    )
    .trim();
}

function getConversationState(chatId: string): ConversationState {
  let state = conversationStates.get(chatId);
  if (!state) {
    state = {
      history: [],
      candidates: [],
      batchTimeout: null,
      processing: false,
      unprocessedMids: new Set(),
      passiveFlushTimer: null,
      passiveProcessing: false,
      lastTouchedAt: Date.now(),
    };
    conversationStates.set(chatId, state);
  }

  state.lastTouchedAt = Date.now();
  return state;
}

function scheduleCandidateProcessing(
  chatId: string,
  state: ConversationState,
): void {
  if (state.batchTimeout) return;
  state.batchTimeout = setTimeout(() => {
    state.batchTimeout = null;
    void processCandidates(chatId);
  }, BATCH_TIMEOUT_MS);
}

function getHistoryForModels(history: ConversationHistoryEntry[]): string[] {
  return history.slice(-20).map((h) => h.content);
}

function appendHistoryPair(
  state: ConversationState,
  userContent: string,
  assistantContent: string,
): void {
  state.history.push(
    { role: "user", content: userContent },
    { role: "assistant", content: assistantContent },
  );
  state.history = state.history.slice(-20);
}

function getPassiveMonitoringConfig() {
  return getConfig().triggers.passiveMonitoring;
}

function trackPassiveMessage(chatId: string, mid: string): void {
  const passive = getPassiveMonitoringConfig();
  if (!passive?.enabled) return;

  const state = getConversationState(chatId);

  // Already tracked (duplicate event).
  if (state.unprocessedMids.has(mid)) return;

  state.unprocessedMids.add(mid);

  logger.debug("Passive: tracked message", {
    chatId,
    mid,
    unprocessedCount: state.unprocessedMids.size,
    countThreshold: passive.messageCount,
  });

  // Count trigger
  if (state.unprocessedMids.size >= passive.messageCount) {
    if (state.passiveFlushTimer) {
      clearTimeout(state.passiveFlushTimer);
      state.passiveFlushTimer = null;
    }

    void processPassiveBatch(chatId);
    return;
  }

  // Time trigger (start once, never reset)
  if (!state.passiveFlushTimer) {
    const delayMs = passive.timeThresholdMs;

    logger.debug("Passive: starting time trigger", {
      chatId,
      delayMs,
    });

    state.passiveFlushTimer = setTimeout(() => {
      state.passiveFlushTimer = null;

      if (state.unprocessedMids.size === 0) return;

      void processPassiveBatch(chatId);
    }, delayMs);
  }
}

function getCandidateContent(
  msg: Message,
  botId: string,
  chatId: string
): CandidateContentResult {
  const config = getConfig();
  const trigger = detectTrigger(msg.textContent ?? "", config);

  let text = msg.textContent ?? "";
  let isDirectMention = trigger.triggered;

  const conversation = getConversationById(chatId);
  if (conversation && !conversation.isGroup) {
      isDirectMention = true;
  }

  if (msg.replyToMessageId) {
    const repliedTo = getMessageByMid(msg.replyToMessageId);
    if (repliedTo?.userId === botId) {
      if (!text.toUpperCase().includes("@BOT")) {
        text = `@BOT ${text}`;
      }
      isDirectMention = true;
    }
  }

  if (trigger.triggered && trigger.match) {
    return { content: applyBotTag(text, trigger.match), isDirectMention };
  }

  return { content: text, isDirectMention };
}

function resolveTargetCandidateIndex(
  target: string | null,
  candidateCount: number,
): number | null {
  if (!target) return null;
  const match = target.match(/^C(\d+)$/i);
  if (!match) return null;
  const slotNum = parseInt(match[1], 10);
  if (slotNum < 1) return null;
  return slotNum - 1;
}

function buildRouterCandidateSlots(candidateTexts: string[]): {
  routerCandidates: string[];
  slotToCandidateIndex: Array<number | null>;
} {
  const maxSlots = CANDIDATE_SIZE;
  const candidates = candidateTexts.slice(-maxSlots);
  const leadingPlaceholders = Math.max(0, maxSlots - candidates.length);

  const routerCandidates = [
    ...Array(leadingPlaceholders).fill("..."),
    ...candidates,
  ];

  const slotToCandidateIndex: Array<number | null> = [
    ...Array(leadingPlaceholders).fill(null),
    ...candidates.map((_, idx) => idx),
  ];

  return {
    routerCandidates,
    slotToCandidateIndex,
  };
}

async function processPassiveBatch(chatId: string): Promise<void> {
  const passiveConfig = getPassiveMonitoringConfig();
  if (!passiveConfig?.enabled) return;

  const state = getConversationState(chatId);
  if (state.passiveProcessing) return;
  state.passiveProcessing = true;

  const consumedMids = new Set<string>();

  try {
    const totalWindow = HISTORY_SIZE + CANDIDATE_SIZE; // always 8

    logger.info("Processing passive batch", {
      chatId,
      unprocessedCount: state.unprocessedMids.size,
      historySize: HISTORY_SIZE,
      candidateSize: CANDIDATE_SIZE,
      totalWindow,
    });

    await runWithAutomationLock("passive-prepare", chatId, async () => {
      await initInstagramSession();
      await navigateToChat(chatId);
      await stampInitialDataMids(chatId, totalWindow);
    });

    // Build router window from DB so candidates are anchored to newly tracked
    // passive mids, not whichever messages happen to be visible in the DOM.
    const dbWindow = getLatestMessages(chatId, 40).filter(
      (m) => !!(m.textContent ?? "").trim(),
    );

    if (!dbWindow.length) {
      logger.warn("Passive batch found no text messages in DB", { chatId });
      return;
    }

    const unprocessed = state.unprocessedMids;
    const candidateMessages = dbWindow
      .filter((m) => unprocessed.has(m.messageId))
      .slice(-CANDIDATE_SIZE);

    for (const candidate of candidateMessages) {
      consumedMids.add(candidate.messageId);
    }

    if (!candidateMessages.length) {
      logger.warn("Passive batch had no unprocessed candidates in DB window", {
        chatId,
        unprocessedCount: unprocessed.size,
      });
      return;
    }

    const firstCandidateIdx = dbWindow.findIndex(
      (m) => m.messageId === candidateMessages[0]?.messageId,
    );
    const historyWindow = dbWindow
      .slice(0, Math.max(0, firstCandidateIdx))
      .slice(-HISTORY_SIZE);

    const modelHistory = historyWindow.map((m) => m.textContent ?? "");
    const candidateTexts = candidateMessages.map((m) => m.textContent ?? "");
    const { routerCandidates, slotToCandidateIndex } =
      buildRouterCandidateSlots(candidateTexts);

    logger.info("Passive batch candidate mids", {
      chatId,
      mids: candidateMessages.map((m) => m.messageId),
    });

    let decision: RouterDecision;
    let classifiedCommand: ClassifiedCommand | null = null;
    let commandCandidateIndex: number | null = null;

    for (let i = candidateMessages.length - 1; i >= 0; i -= 1) {
      const messageText = candidateTexts[i] ?? "";
      if (!(await hasCommandTriggerKeyword(messageText))) continue;

      try {
        const classified = await classifyCommand(messageText);
        if (!classified) continue;

        classifiedCommand = classified;
        commandCandidateIndex = i;
        break;
      } catch (cmdErr) {
        logger.warn(
          "Passive command classifier failed, falling back to router",
          {
            chatId,
            mid: candidateMessages[i]?.messageId,
            error: (cmdErr as Error).message,
          },
        );
      }
    }

    if (classifiedCommand && commandCandidateIndex !== null) {
      const firstRealSlot = CANDIDATE_SIZE - candidateMessages.length;
      const targetSlot = firstRealSlot + commandCandidateIndex + 1;
      const title = classifiedCommand.query || classifiedCommand.commandName;

      decision = {
        type: classifiedCommand.actionType,
        target: `C${targetSlot}`,
        effort: classifiedCommand.actionType === "text" ? "medium" : null,
        title,
        reason: `Passive command classifier (${classifiedCommand.commandName}) score=${classifiedCommand.similarity.toFixed(3)}`,
      };

      logger.info("Passive command classifier matched", {
        chatId,
        mid: candidateMessages[commandCandidateIndex]?.messageId,
        commandName: classifiedCommand.commandName,
        actionType: classifiedCommand.actionType,
        similarity: classifiedCommand.similarity,
        query: classifiedCommand.query,
        target: decision.target,
      });
    } else {
      const rawDecision = await invokeRouter(modelHistory, routerCandidates);
      decision = normalizeRouterDecision(rawDecision);
    }

    logger.info("Passive monitoring router decision", {
      chatId,
      type: decision.type,
      target: decision.target,
      effort: decision.effort,
      title: decision.title,
    });

    emitEvent({
      type: "ROUTER_DECISION",
      chatId,
      decision,
      resultText: null,
    });

    if (decision.type === "ignore") {
      return;
    }

    const targetIndex = resolveTargetCandidateIndex(
      decision.target,
      slotToCandidateIndex.length,
    );

    if (
      targetIndex === null ||
      targetIndex < 0 ||
      targetIndex >= slotToCandidateIndex.length
    ) {
      logger.warn("Passive batch decision had invalid target", {
        chatId,
        target: decision.target,
        targetIndex,
        slotCount: slotToCandidateIndex.length,
      });
      return;
    }

    const mappedCandidateIndex = slotToCandidateIndex[targetIndex];

    if (mappedCandidateIndex === null || mappedCandidateIndex === undefined) {
      logger.warn("Passive batch target resolved to placeholder slot", {
        chatId,
        target: decision.target,
        targetIndex,
      });
      return;
    }

    if (
      mappedCandidateIndex < 0 ||
      mappedCandidateIndex >= candidateMessages.length
    ) {
      logger.warn("Passive batch mapped candidate index out of range", {
        chatId,
        target: decision.target,
        mappedIndex: mappedCandidateIndex,
        candidateCount: candidateMessages.length,
      });
      return;
    }

    const targetCandidate = candidateMessages[mappedCandidateIndex];
    if (!targetCandidate) {
      logger.warn("Passive batch target candidate unavailable", {
        chatId,
        target: decision.target,
        index: mappedCandidateIndex,
      });
      return;
    }

    if (decision.type === "text" && !!targetCandidate.replyToMessageId) {
      logger.info("Passive batch: skipping text action for reply candidate", {
        chatId,
        target: decision.target,
        targetMid: targetCandidate.messageId,
        replyToMessageId: targetCandidate.replyToMessageId,
      });
      return;
    }

    const targetMid = targetCandidate.messageId;
    const dbMessage = getMessageByMid(targetMid);
    if (!dbMessage) {
      logger.warn("Passive batch target missing in DB; skipping", {
        chatId,
        targetMid,
      });
      return;
    }

    await attachDataMidToDOM(chatId, targetMid);

    const context: ActionContext = {
      chatId,
      message: dbMessage as Message,
      history: modelHistory,
      candidates: candidateTexts,
      decision,
      targetMessageId: targetMid,
      targetTextContent: targetCandidate.textContent ?? "",
      classifiedCommand: classifiedCommand ?? undefined,
    };

    let resultText: string | null = null;
    try {
      resultText = await executeAction(context);
    } catch (err) {
      logger.error("Passive action execution failed", {
        chatId,
        targetMid,
        error: (err as Error).message,
      });
    }

    insertOutgoing({
      conversationId: chatId,
      targetMessageId: targetMid,
      actionType: decision.type,
      effortLevel: decision.effort ?? null,
      intentLabel: decision.title ?? null,
      messageContent: resultText,
      executionStatus: resultText !== null ? "sent" : "failed",
      platformMessageId: null,
    });

    emitEvent({
      type: "OUTGOING",
      chatId,
      actionType: decision.type,
      content: resultText,
    });

    appendHistoryPair(
      state,
      (targetCandidate.textContent ?? "").replace(/@BOT/gi, "").trim(),
      resultText ?? `[${decision.type}]`,
    );
  } finally {
    // Only clear mids touched by this batch so transient failures can retry.
    for (const mid of consumedMids) {
      state.unprocessedMids.delete(mid);
    }

    if (state.unprocessedMids.size === 0 && state.passiveFlushTimer) {
      clearTimeout(state.passiveFlushTimer);
      state.passiveFlushTimer = null;
    }

    state.passiveProcessing = false;
    state.lastTouchedAt = Date.now();
  }
}

function normalizeRouterDecision(decision: RouterDecision): RouterDecision {
  if (!decision.target) return decision;

  const match = decision.target.match(/^C(\d+)$/i);
  if (!match) return decision;

  const targetNum = parseInt(match[1], 10);
  if (targetNum > 3) {
    logger.warn("Router gave out-of-range target, treating as ignore", {
      originalTarget: decision.target,
      originalType: decision.type,
    });

    return {
      type: "ignore",
      target: null,
      effort: null,
      title: null,
      reason:
        decision.reason ??
        `Normalized invalid target ${decision.target} to ignore`,
    };
  }

  return decision;
}

async function processCandidates(chatId: string): Promise<void> {
  const config = getConfig();
  const state = getConversationState(chatId);

  if (state.processing || state.candidates.length === 0) return;

  state.processing = true;

  try {
    const toProcess = [...state.candidates];
    state.candidates = [];

    for (const candidate of toProcess) {
      const msg = getMessageByMid(candidate.messageId);
      if (!msg) {
        continue;
      }

      const ageMs = Date.now() - candidate.queuedAtMs;
      logger.debug("Candidate age check", {
        chatId,
        mid: msg.messageId,
        ageMs,
        cutoffMs: MAX_MESSAGE_AGE_MS,
      });

      if (ageMs > MAX_MESSAGE_AGE_MS) {
        logger.warn("Skipping candidate: too old", {
          chatId,
          mid: msg.messageId,
          ageMs,
          cutoffMs: MAX_MESSAGE_AGE_MS,
        });
        continue;
      }

      const modelHistory = getHistoryForModels(state.history);

      try {
        let decision: RouterDecision;
        let classifiedCommand = null;

        const hasCommandTrigger = await hasCommandTriggerKeyword(
          candidate.content,
        );

        // Run embedding classifier first when command trigger words are present.
        if (hasCommandTrigger) {
          try {
            classifiedCommand = await classifyCommand(candidate.content);
          } catch (cmdErr) {
            logger.warn("Command classifier failed, falling back to router", {
              chatId,
              mid: msg.messageId,
              error: (cmdErr as Error).message,
            });
          }
        }

        if (classifiedCommand) {
          const title =
            classifiedCommand.query || classifiedCommand.commandName;
          decision = {
            type: classifiedCommand.actionType,
            target: "C1",
            effort: classifiedCommand.actionType === "text" ? "medium" : null,
            title,
            reason: `Command classifier (${classifiedCommand.commandName}) score=${classifiedCommand.similarity.toFixed(3)}`,
          };

          logger.info("Command classifier matched", {
            chatId,
            mid: msg.messageId,
            commandName: classifiedCommand.commandName,
            actionType: classifiedCommand.actionType,
            similarity: classifiedCommand.similarity,
            query: classifiedCommand.query,
          });
        } else {
          const rawDecision = await invokeRouter(modelHistory, [
            candidate.content,
          ]);
          decision = normalizeRouterDecision(rawDecision);
        }

        logger.info("Router decision", {
          chatId,
          mid: msg.messageId,
          type: decision.type,
          target: decision.target,
          effort: decision.effort,
          title: decision.title,
        });

        emitEvent({
          type: "ROUTER_DECISION",
          chatId,
          decision,
          resultText: null,
        });

        if (decision.type === "ignore") {
          logger.info("Skipping candidate per router decision", {
            chatId,
            mid: msg.messageId,
          });
          continue;
        }

        const context: ActionContext = {
          chatId,
          message: msg as Message,
          history: modelHistory,
          candidates: [candidate.content],
          decision,
          targetMessageId: msg.messageId,
          targetTextContent: msg.textContent,
          classifiedCommand: classifiedCommand || undefined,
        };

        let resultText: string | null = null;
        try {
          resultText = await executeAction(context);
        } catch (err) {
          logger.error("Action execution failed", {
            chatId,
            mid: msg.messageId,
            error: (err as Error).message,
          });
        }

        insertOutgoing({
          conversationId: chatId,
          targetMessageId: msg.messageId,
          actionType: decision.type,
          effortLevel: decision.effort ?? null,
          intentLabel: decision.title ?? null,
          messageContent: resultText,
          executionStatus: resultText !== null ? "sent" : "failed",
          platformMessageId: null,
        });

        emitEvent({
          type: "OUTGOING",
          chatId,
          actionType: decision.type,
          content: resultText,
        });

        appendHistoryPair(
          state,
          candidate.content.replace(/@BOT/gi, "").trim(),
          resultText ?? `[${decision.type}]`,
        );

        if (config.debug.logRouterWindow) {
          logger.info("Conversation state", {
            chatId,
            historyEntries: state.history.length,
            pendingCandidates: state.candidates.length,
          });
        }
      } catch (err) {
        logger.error("Candidate processing failed", {
          chatId,
          mid: msg.messageId,
          error: (err as Error).message,
        });
      }
    }
  } finally {
    state.processing = false;
    state.lastTouchedAt = Date.now();
  }

  // If new candidates arrived while this batch was processing, flush promptly.
  if (state.candidates.length > 0 && !state.batchTimeout) {
    state.batchTimeout = setTimeout(() => {
      state.batchTimeout = null;
      void processCandidates(chatId);
    }, 0);
  }
}

// Process a single message

export async function processMessage(
  chatId: string,
  mid: string,
): Promise<void> {
  const config = getConfig();
  const botId = config.instagram.fbId ?? "";

  const msg = getMessageByMid(mid);
  if (!msg) {
    logger.warn("Message not found in DB yet", { chatId, mid });
    return;
  }
  if (msg.userId === botId) {
    logger.debug("Skipping message from bot", { chatId, mid });
    return;
  }
  if (!msg.textContent) {
    logger.debug("Skipping message with no text", { chatId, mid });
    return;
  }

  try {
    const { content: candidateText, isDirectMention } = getCandidateContent(
      msg as Message,
      botId,
      chatId,
    );

    if (!isDirectMention) {
      trackPassiveMessage(chatId, mid);
      return;
    }

    const state = getConversationState(chatId);

    if (state.candidates.some((c) => c.messageId === mid)) {
      logger.debug("Message already queued", { chatId, mid });
      return;
    }

    state.candidates.push({
      messageId: mid,
      content: candidateText,
      queuedAtMs: Date.now(),
    });

    while (state.candidates.length > BATCH_HARD_LIMIT) {
      const dropped = state.candidates.shift();
      if (!dropped) break;
      logger.warn("Dropped queued message due queue cap", {
        chatId,
        mid: dropped.messageId,
        queueCap: BATCH_HARD_LIMIT,
      });
    }

    if (config.debug.logRouterWindow) {
      logger.info("Queued candidate", {
        chatId,
        mid,
        queueLength: state.candidates.length,
      });
    }

    if (state.candidates.length >= BATCH_HARD_LIMIT && !state.processing) {
      if (state.batchTimeout) {
        clearTimeout(state.batchTimeout);
        state.batchTimeout = null;
      }
      await processCandidates(chatId);
      return;
    }

    scheduleCandidateProcessing(chatId, state);
  } catch (err) {
    logger.error("Error processing message", {
      chatId,
      mid,
      error: (err as Error).message,
    });
    throw err;
  }
}
