/**
 * Message processing pipeline.
 *
 * Event-driven: called per-message when a NEW_MESSAGE or EDIT WebSocket event arrives.
 *
 * Processing flow:
 *   1. Load message by mid
 *   2. Skip if bot's own, already processed/locked, no text
 *   3. Detect triggers — if found, replace with @BOT
 *   4. Build history (H1–H5) + candidates (C1–C3) context
 *   5. Invoke router
 *   6. Resolve target from candidate slots
 *   7. Dispatch action
 *   8. Audit log + mark processed
 */

import {
  getWindowMessages,
  getMessageByMid,
  lockMessage,
  markMessageProcessed,
  unlockMessage,
} from "@/db/queries/messages.js";
import { insertOutgoing } from "@/db/queries/outgoing.js";
import { invokeRouter } from "@/router/router.js";
import { executeAction } from "@/router/dispatcher.js";
import { emitEvent } from "@/events.js";
import logger from "@/utils/logger.js";
import getConfig from "@/runtime/index.js";
import type { ActionContext, Message } from "@/types/index.js";

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

const _candidateBatchStart = new Map<string, number>();

function resolveTarget(
  target: string | null,
  candidateMsgs: Message[],
): Message | null {
  if (!target) return null;

  const match = target.match(/C(\d)/i);
  if (!match) return null;

  const slotIndex = parseInt(match[1], 10) - 1;
  const offset = 3 - candidateMsgs.length;
  const realIndex = slotIndex - offset;

  if (realIndex < 0 || realIndex >= candidateMsgs.length) return null;

  return candidateMsgs[realIndex];
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
  if (msg.processedAt || msg.processingLockAt) return;
  if (!msg.textContent) return;

  const messageText = msg.textContent;
  const trigger = detectTrigger(messageText, config);

  // Also treat a direct reply to the bot as a trigger
  const isReplyToBot = (() => {
    if (!msg.replyToMessageId) return false;
    const repliedTo = getMessageByMid(msg.replyToMessageId);
    return repliedTo?.userId === botId;
  })();
  const isTrigger = trigger.triggered || isReplyToBot;

  lockMessage(mid);

  try {
    logger.info("Processing message", {
      chatId,
      mid,
      triggered: isTrigger,
      trigger: trigger.match,
      isReplyToBot,
    });

    let historyMsgs: Message[];
    let candidateMsgs: Message[];
    let historyTexts: string[];
    let candidateTexts: string[];

    const windowResult = getWindowMessages(chatId, botId, 5);
    historyMsgs = windowResult.history;
    candidateMsgs = windowResult.candidates;
    historyTexts = historyMsgs.map((m) => m.textContent ?? "");

    // Threshold gate (bypassed for trigger invocations and replies to bot).
    if (!isTrigger) {
      const threshold = config.router.candidateThreshold;
      const timeoutMs = config.router.timeoutMs;

      if (!_candidateBatchStart.has(chatId)) {
        _candidateBatchStart.set(chatId, Date.now());
      }
      const batchStart = _candidateBatchStart.get(chatId)!;
      const elapsed = Date.now() - batchStart;
      const ready = candidateMsgs.length >= threshold || elapsed >= timeoutMs;

      if (!ready) {
        const remaining = timeoutMs - elapsed;
        logger.info("Router deferred: waiting for more candidates or timeout", {
          chatId,
          candidates: candidateMsgs.length,
          threshold,
          elapsedMs: elapsed,
          retryInMs: remaining,
        });
        unlockMessage(mid);
        setTimeout(() => processMessage(chatId, mid), remaining);
        return;
      }

      _candidateBatchStart.delete(chatId);
    }

    candidateTexts = candidateMsgs.map((m) => {
      let text = m.textContent ?? "";

      // If this message is a reply to a bot message, treat it as a direct
      if (m.replyToMessageId) {
        const repliedTo = getMessageByMid(m.replyToMessageId);
        if (repliedTo && repliedTo.userId === botId) {
          text = `@BOT ${text}`;
        }
      }

      if (trigger.triggered && trigger.match) {
        return applyBotTag(text, trigger.match);
      }
      return text;
    });

    if (config.debug.logRouterWindow) {
      logger.info("Router window", {
        chatId,
        history: historyTexts.map((t, i) => `H${i + 1}:${t}`).join(" | "),
        candidates: candidateTexts.map((t, i) => `C${i + 1}:${t}`).join(" | "),
      });
    }

    // Invoke router
    const decision = await invokeRouter(historyTexts, candidateTexts);

    logger.info("Router decision", {
      chatId,
      type: decision.type,
      target: decision.target,
      effort: decision.effort,
      title: decision.title,
    });

    emitEvent({ type: "ROUTER_DECISION", chatId, decision, resultText: null });

    // Resolve target message from candidates
    const targetMsg = resolveTarget(decision.target, candidateMsgs);

    const context: ActionContext = {
      chatId,
      message: msg as Message,
      history: historyTexts,
      candidates: candidateTexts,
      decision,
      targetMessageId: targetMsg?.messageId ?? null,
      targetTextContent: targetMsg?.textContent ?? null,
    };

    // Execute action
    let resultText: string | null = null;
    try {
      resultText = await executeAction(context);
    } catch (err) {
      logger.error("Action execution failed", {
        chatId,
        error: (err as Error).message,
      });
    }

    // Audit log
    insertOutgoing({
      conversationId: chatId,
      targetMessageId: targetMsg?.messageId ?? null,
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

    // Mark all candidates processed — prevents leftover candidates from being
    // re-picked in the next pipeline run and triggering duplicate actions.
    for (const m of candidateMsgs) {
      markMessageProcessed(m.messageId);
    }
  } catch (err) {
    unlockMessage(mid);
    throw err;
  }
}
