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

import {
  getMessageByMid,
} from "@/db/queries/messages.js";
import { insertOutgoing } from "@/db/queries/outgoing.js";
import { getRecentDomMessages } from "@/automation/chat.js";
import { initInstagramSession } from "@/automation/session.js";
import { navigateToChat } from "@/automation/navigation.js";
import { invokeRouter } from "@/router/router.js";
import { executeAction } from "@/router/dispatcher.js";
import { emitEvent } from "@/events.js";
import logger from "@/utils/logger.js";
import getConfig from "@/runtime/index.js";
import type { ActionContext, Message, RouterDecision } from "@/types/index.js";

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

interface PassiveMonitoringState {
  recentMessages: Array<{ mid: string; timestamp: number }>;
  lastCheckTime: number;
  processing: boolean;
}

interface ConversationState {
  history: ConversationHistoryEntry[];
  candidates: QueuedCandidate[];
  batchTimeout: ReturnType<typeof setTimeout> | null;
  processing: boolean;
}

const conversationStates = new Map<string, ConversationState>();
const passiveStates = new Map<string, PassiveMonitoringState>();

const BATCH_TIMEOUT_MS = 2000;
const BATCH_HARD_LIMIT = 3;
const MAX_MESSAGE_AGE_MS = 20_000;
const CANDIDATE_SIZE = 3;
const MAX_HISTORY_SIZE = 10;
const MIN_HISTORY_SIZE = 5;
const PASSIVE_MIN_COOLDOWN_MS = 3000;

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
    };
    conversationStates.set(chatId, state);
  }
  return state;
}

function scheduleCandidateProcessing(chatId: string, state: ConversationState): void {
  if (state.batchTimeout) return;
  state.batchTimeout = setTimeout(() => {
    state.batchTimeout = null;
    void processCandidates(chatId);
  }, BATCH_TIMEOUT_MS);
}

function getHistoryForModels(history: ConversationHistoryEntry[]): string[] {
  return history.slice(-10).map((h) => `${h.role}: ${h.content}`);
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
  state.history = state.history.slice(-10);
}

function getPassiveState(chatId: string): PassiveMonitoringState {
  let state = passiveStates.get(chatId);
  if (!state) {
    state = {
      recentMessages: [],
      lastCheckTime: 0,
      processing: false,
    };
    passiveStates.set(chatId, state);
  }
  return state;
}

function getPassiveMonitoringConfig() {
  return getConfig().triggers.passiveMonitoring;
}

function trackPassiveMessage(chatId: string, mid: string): void {
  const passive = getPassiveMonitoringConfig();
  if (!passive?.enabled) return;

  const state = getPassiveState(chatId);
  state.recentMessages.push({ mid, timestamp: Date.now() });
}

function checkPassiveThreshold(chatId: string): boolean {
  const passive = getPassiveMonitoringConfig();
  if (!passive?.enabled) return false;

  const state = getPassiveState(chatId);
  const now = Date.now();
  const cooldownMs = Math.max(
    PASSIVE_MIN_COOLDOWN_MS,
    passive.cooldownMs ?? PASSIVE_MIN_COOLDOWN_MS,
  );

  state.recentMessages = state.recentMessages.filter(
    (m) => now - m.timestamp < passive.timeWindow,
  );

  const sinceLastCheck = now - state.lastCheckTime;
  if (state.lastCheckTime > 0 && sinceLastCheck < cooldownMs) {
    logger.info("Passive monitoring in cooldown", {
      chatId,
      sinceLastCheck,
      cooldownMs,
      bufferedMessages: state.recentMessages.length,
    });
    return false;
  }

  return state.recentMessages.length >= passive.messageCount;
}

function getCandidateContent(msg: Message, botId: string): CandidateContentResult {
  const config = getConfig();
  const trigger = detectTrigger(msg.textContent ?? "", config);

  let text = msg.textContent ?? "";
  let isDirectMention = trigger.triggered;

  if (msg.replyToMessageId) {
    const repliedTo = getMessageByMid(msg.replyToMessageId);
    if (repliedTo?.userId === botId) {
      text = `@BOT ${text}`;
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
  const idx = parseInt(match[1], 10) - 1;
  if (idx < 0 || idx >= candidateCount) return null;
  return idx;
}

async function processPassiveBatch(chatId: string): Promise<void> {
  const passiveConfig = getPassiveMonitoringConfig();
  if (!passiveConfig?.enabled) return;

  const passiveState = getPassiveState(chatId);
  if (passiveState.processing) return;
  passiveState.processing = true;

  try {
    const threshold = Math.max(CANDIDATE_SIZE, passiveConfig.messageCount);
    const historySize = Math.min(
      MAX_HISTORY_SIZE,
      Math.max(MIN_HISTORY_SIZE, threshold - CANDIDATE_SIZE),
    );
    const totalWindow = historySize + CANDIDATE_SIZE;

    logger.info("Processing passive batch", {
      chatId,
      threshold,
      historySize,
      candidateSize: CANDIDATE_SIZE,
      totalWindow,
    });

    await initInstagramSession();
    await navigateToChat(chatId);

    const domMessages = await getRecentDomMessages(totalWindow);
    if (domMessages.length < CANDIDATE_SIZE) {
      logger.warn("Not enough DOM messages for passive batch", {
        chatId,
        count: domMessages.length,
        required: CANDIDATE_SIZE,
      });
      return;
    }

    const windowMsgs = domMessages.slice(-totalWindow);
    const candidatesWindow = windowMsgs.slice(-CANDIDATE_SIZE);
    const historyWindow = windowMsgs
      .slice(0, Math.max(0, windowMsgs.length - CANDIDATE_SIZE))
      .slice(-historySize);

    const modelHistory = historyWindow.map((m) => `user: ${m.text}`);
    const candidateTexts = candidatesWindow.map((m) => m.text);

    const rawDecision = await invokeRouter(modelHistory, candidateTexts);
    const decision = normalizeRouterDecision(rawDecision);

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
      candidatesWindow.length,
    );

    if (targetIndex === null) {
      logger.warn("Passive batch decision had unresolved target; skipping", {
        chatId,
        target: decision.target,
      });
      return;
    }

    const targetCandidate = candidatesWindow[targetIndex];
    if (!targetCandidate?.mid) {
      logger.warn("Passive batch target missing data-mid; skipping", {
        chatId,
        target: decision.target,
      });
      return;
    }

    const dbMessage = getMessageByMid(targetCandidate.mid);
    if (!dbMessage) {
      logger.warn("Passive batch target missing in DB; skipping", {
        chatId,
        targetMid: targetCandidate.mid,
      });
      return;
    }

    const context: ActionContext = {
      chatId,
      message: dbMessage as Message,
      history: modelHistory,
      candidates: candidateTexts,
      decision,
      targetMessageId: targetCandidate.mid,
      targetTextContent: targetCandidate.text,
    };

    let resultText: string | null = null;
    try {
      resultText = await executeAction(context);
    } catch (err) {
      logger.error("Passive action execution failed", {
        chatId,
        targetMid: targetCandidate.mid,
        error: (err as Error).message,
      });
    }

    insertOutgoing({
      conversationId: chatId,
      targetMessageId: targetCandidate.mid,
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

    const conversationState = getConversationState(chatId);
    appendHistoryPair(
      conversationState,
      targetCandidate.text,
      resultText ?? `[${decision.type}]`,
    );
  } finally {
    passiveState.recentMessages = [];
    passiveState.lastCheckTime = Date.now();
    passiveState.processing = false;
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
        decision.reason ?? `Normalized invalid target ${decision.target} to ignore`,
    };
  }

  return decision;
}

async function processCandidates(chatId: string): Promise<void> {
  const config = getConfig();
  const state = getConversationState(chatId);

  if (state.processing || state.candidates.length === 0) return;

  state.processing = true;

  const toProcess = [...state.candidates];
  state.candidates = [];

  for (const candidate of toProcess) {
    const msg = getMessageByMid(candidate.messageId);
    if (!msg) {
      continue;
    }

    const ageMs = Date.now() - candidate.queuedAtMs;
    logger.info("Candidate age check", {
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
      const rawDecision = await invokeRouter(modelHistory, [candidate.content]);
      const decision = normalizeRouterDecision(rawDecision);

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
        candidate.content,
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

  state.processing = false;

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

  // Load the specific message
  const msg = getMessageByMid(mid);
  if (!msg) return;
  if (msg.userId === botId) return;
  if (!msg.textContent) return;

  try {
    const { content: candidateText, isDirectMention } = getCandidateContent(
      msg as Message,
      botId,
    );

    if (!isDirectMention) {
      trackPassiveMessage(chatId, mid);

      if (!checkPassiveThreshold(chatId)) {
        return;
      }

      logger.info("Passive monitoring threshold reached", {
        chatId,
        messageCount: getPassiveState(chatId).recentMessages.length,
      });

      await processPassiveBatch(chatId);
      return;
    }

    const state = getConversationState(chatId);

    // Avoid duplicate queue entries for the same message.
    if (state.candidates.some((c) => c.messageId === mid)) {
      return;
    }

    state.candidates.push({
      messageId: mid,
      content: candidateText,
      queuedAtMs: Date.now(),
    });

    // Keep queue bounded even if events outpace processing.
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
    throw err;
  }
}
