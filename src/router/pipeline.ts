/**
 * Message processing pipeline.
 *
 * Event-driven: called per-message when a NEW_MESSAGE or EDIT WebSocket event arrives.
 *
 * Processing flow:
 *   1. Load message by mid
 *   2. Skip if bot's own, already processed/locked, no text
 *   3. Detect triggers — if found, replace with @BOT
 *   4. Build 5-message sliding window
 *   5. Invoke router
 *   6. Resolve target with safety rule
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
import { insertOutgoingMessage } from "@/db/queries/outgoing.js";
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

  for (const keyword of triggers.keywords ?? []) {
    if (lower.includes(keyword.toLowerCase())) {
      return { triggered: true, match: keyword };
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

// Target resolver with safety rule

function resolveTarget(
  target: string | null,
  msgs: Message[],
  botId: string,
): Message | null {
  if (!target) return null;

  const match = target.match(/M(\d)/i);
  if (!match) return null;

  const index = parseInt(match[1], 10) - 1;
  const padOffset = 5 - msgs.length;
  const realIndex = index - padOffset;

  if (realIndex < 0 || realIndex >= msgs.length) return null;

  let resolved = msgs[realIndex];

  // Safety rule: if router selected a bot message, shift to nearest valid user message
  if (resolved.senderFbid === botId) {
    for (let i = realIndex + 1; i < msgs.length; i++) {
      if (msgs[i].senderFbid !== botId) {
        resolved = msgs[i];
        logger.info(
          "Target safety: shifted from bot message to next user message",
          {
            originalIndex: realIndex,
            newIndex: i,
          },
        );
        return resolved;
      }
    }
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].senderFbid !== botId) {
        resolved = msgs[i];
        logger.info("Target safety: fallback to newest user message", {
          index: i,
        });
        return resolved;
      }
    }
    return null;
  }

  return resolved;
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
  if (msg.senderFbid === botId) return;
  if (msg.processedAt || msg.processingLockAt) return;
  if (!msg.textBody) return;

  const messageText = msg.textBody;

  const trigger = detectTrigger(messageText, config);

  lockMessage(mid);

  try {
    logger.info("Processing message", {
      chatId,
      mid,
      triggered: trigger.triggered,
      trigger: trigger.match,
    });

    let windowMessages: Message[];
    let texts: string[];

    if (trigger.triggered && trigger.match) {
      windowMessages = [msg as Message];
      texts = [
        "...",
        "...",
        "...",
        "...",
        applyBotTag(messageText, trigger.match),
      ];
    } else {
      windowMessages = getWindowMessages(chatId, botId, 5) as Message[];
      texts = windowMessages.map((m) => m.textBody ?? "");
      while (texts.length < 5) texts.unshift("...");
    }

    if (config.debug.logRouterWindow) {
      logger.info("Router window", {
        chatId,
        window: texts.map((t, i) => `M${i + 1}:${t}`).join(" | "),
      });
    }

    // Invoke router
    const decision = await invokeRouter(texts);

    logger.info("Router decision", {
      chatId,
      type: decision.type,
      target: decision.target,
      effort: decision.effort,
      title: decision.title,
    });

    emitEvent({ type: "ROUTER_DECISION", chatId, decision, resultText: null });

    // Resolve target message with safety rule
    const targetMsg = resolveTarget(decision.target, windowMessages, botId);

    const context: ActionContext = {
      chatId,
      message: msg as Message,
      window: texts,
      decision,
      targetMid: targetMsg?.mid ?? null,
      targetTextBody: targetMsg?.textBody ?? null,
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
    insertOutgoingMessage({
      chatId,
      targetMessageMid: targetMsg?.mid ?? null,
      type: decision.type,
      effort: decision.effort ?? null,
      title: decision.title ?? null,
      content: resultText,
      reason: decision.reason ?? null,
      platformMid: null,
    });

    emitEvent({
      type: "OUTGOING",
      chatId,
      actionType: decision.type,
      content: resultText,
    });

    markMessageProcessed(mid);
  } catch (err) {
    unlockMessage(mid);
    throw err;
  }
}
