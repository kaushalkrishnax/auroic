/**
 * Generates a multimodal response and delivers its segments in order.
 * Every segment is verified by its automation handler before the next begins.
 */

import logger from "@/utils/logger.js";
import {
  sendText,
  sendSticker,
  sendGIF,
  sendVoiceNote,
  playMusic,
} from "@/automation/chat.js";
import { generateReply } from "@/llm/generate.js";
import { hasDeliverableSegments, parseResponse } from "@/response/protocol.js";
import type { ActionContext } from "@/types/index.js";

export async function executeText(context: ActionContext): Promise<string | null> {
  const { chatId, decision, history, candidates, targetTextContent } = context;

  if (!decision.effort) {
    logger.warn("Text action missing effort level", decision);
    return null;
  }

  const generatorCandidates = targetTextContent ? [targetTextContent] : candidates;
  const cleanCandidates = generatorCandidates.map((value) => value.replace(/@BOT/gi, "").trim());
  const cleanHistory = history.map((value) => value.replace(/@BOT/gi, "").trim());

  let generated: string;
  try {
    generated = await generateReply(cleanHistory, cleanCandidates, decision.effort, "multimodal");
  } catch (err) {
    logger.error("Multimodal response generation failed", {
      chatId,
      error: (err as Error).message,
    });
    return null;
  }

  const parsed = parseResponse(generated);
  if (!hasDeliverableSegments(parsed)) {
    logger.error("Rejected malformed or empty multimodal response", {
      chatId,
      errors: parsed.errors,
      outputLength: generated?.length ?? 0,
    });
    return null;
  }

  const delivered: string[] = [];
  const failed: string[] = [];
  const targetMid = context.targetMessageId ?? undefined;

  for (const [index, segment] of parsed.segments.entries()) {
    let sent = false;
    let description = "";
    
    const segmentTargetMid = delivered.length === 0 ? targetMid : undefined;

    try {
      switch (segment.type) {
        case "text":
          description = segment.value;
          sent = await sendText(segment.value, chatId, segmentTargetMid);
          break;
        case "sticker":
          description = `[sticker: ${segment.intent}]`;
          sent = await sendSticker(segment.intent, chatId, segmentTargetMid);
          break;
        case "gif":
          description = `[gif: ${segment.intent}]`;
          sent = await sendGIF(segment.intent, chatId, segmentTargetMid);
          break;
        case "voice":
          description = `[voice: ${segment.text}]`;
          sent = await sendVoiceNote(segment.text, chatId, segmentTargetMid);
          break;
        case "music":
          description = `[music: ${segment.title}]`;
          sent = await playMusic(segment.title, chatId);
          break;
      }
    } catch (err) {
      logger.error("Response segment execution threw", {
        chatId,
        segmentIndex: index,
        segmentType: segment.type,
        error: (err as Error).message,
      });
    }

    if (sent) {
      delivered.push(description);
      logger.info("Response segment delivered", {
        chatId,
        segmentIndex: index,
        segmentType: segment.type,
      });
    } else {
      failed.push(description);
      logger.warn("Response segment delivery failed; continuing remaining segments", {
        chatId,
        segmentIndex: index,
        segmentType: segment.type,
      });
    }
  }

  if (!delivered.length) return null;

  logger.info("Multimodal response execution completed", {
    chatId,
    segmentCount: parsed.segments.length,
    deliveredCount: delivered.length,
    failedCount: failed.length,
  });

  return delivered.join(" ");
}
