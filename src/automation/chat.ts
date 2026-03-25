/**
 * Instagram chat interaction helpers.
 * Message targeting uses index-based DOM matching instead of text search.
 */

import fs from "fs";
import type { Locator, Page } from "playwright";
import { find } from "node-emoji";
import { parseBuffer } from "music-metadata";
import { getPage } from "@/automation/session.js";
import { getConversationById } from "@/db/queries/conversations.js";
import { getLatestMessages, getMessageByMid } from "@/db/queries/messages.js";
import SELECTORS from "@/instagram/selectors.js";
import logger from "@/utils/logger.js";
import { sleep } from "@/utils/delay.js";
import { generateSpeechBuffer, playBuffer } from "@/runtime/tts.js";

const TARGET_MAX_AGE_MS = 20_000;

function isTargetChatOpen(chatId: string): boolean {
  try {
    const page = getPage();
    return page.url().includes(`/direct/t/${chatId}`);
  } catch {
    return false;
  }
}

export interface DomMessageSnapshot {
  mid: string | null;
  text: string;
}

/* ------------------------------------------------ */
/* Helper utilities                                  */
/* ------------------------------------------------ */

async function visible(locator: Locator, timeout = 2500): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

async function click(locator: Locator): Promise<boolean> {
  if (!(await visible(locator, 2000))) return false;
  try {
    await locator.click({ timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

async function hover(locator: Locator): Promise<boolean> {
  if (!(await visible(locator, 2000))) return false;
  try {
    await locator.hover({ timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------ */
/* Message container resolution                      */
/* ------------------------------------------------ */

async function findMessageContainer(
  chatId: string,
  targetMid?: string,
): Promise<Locator | null> {
  const page = getPage();

  if (targetMid) {
    const escapedMid = targetMid.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const byMid = page.locator(`[data-mid="${escapedMid}"]`).first();
    if ((await byMid.count()) > 0) {
      return byMid;
    }
  }

  const messageList = page.locator(SELECTORS.messageList);
  const allGroups = messageList.locator(SELECTORS.messageGroup);

  const groupCount = await allGroups.count();
  if (!groupCount) {
    logger.warn("No message groups found in DOM");
    return null;
  }

  const dbMessages = getLatestMessages(chatId, 10);
  const take = Math.min(10, groupCount, dbMessages.length);

  if (!take) {
    logger.warn("No messages to build window from", {
      groupCount,
      dbCount: dbMessages.length,
    });
    return null;
  }

  const domGroups: Locator[] = [];
  for (let i = groupCount - 1; i >= 0 && domGroups.length < take; i--) {
    const group = allGroups.nth(i);
    try {
      if (await group.isVisible()) {
        domGroups.unshift(group);
      }
    } catch {
      // Group detached while iterating; skip and continue.
    }
  }

  // If visibility probing couldn't collect enough rows, fall back to raw tail.
  if (domGroups.length < take) {
    domGroups.length = 0;
    for (let i = groupCount - take; i < groupCount; i++) {
      domGroups.push(allGroups.nth(i));
    }
  }

  const dbSlice = dbMessages.slice(-take);

  logger.debug("Messages in DB window", { chatId, count: dbSlice.length });

  const index = dbSlice.findIndex((m) => m.messageId === targetMid);

  if (index === -1) {
    logger.warn("Target mid not found in window", { targetMid, chatId });
    return null;
  }

  return domGroups[index];
}

async function setDataMidOnContainer(
  container: Locator,
  targetMid: string,
): Promise<void> {
  await container.evaluate((el, mid) => {
    el.setAttribute("data-mid", mid);
  }, targetMid);
}

/**
 * Stamps a stable `data-mid` attribute on the DOM message node.
 *
 * Resolution uses the short-window DB↔DOM index mapping as a fallback,
 * retrying briefly because Instagram can render the node slightly after
 * the websocket event is received.
 */
export async function attachDataMidToDOM(
  chatId: string,
  targetMid: string,
): Promise<boolean> {
  if (!isTargetChatOpen(chatId)) {
    return false;
  }

  const attempts = 5;
  let lastError: Error | null = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const container = await findMessageContainer(chatId, targetMid);
      if (container) {
        await setDataMidOnContainer(container, targetMid);
        logger.info("Attached data-mid to DOM message", { chatId, targetMid, attempt: i + 1 });
        return true;
      }
    } catch (err) {
      lastError = err as Error;
      logger.debug("Attempt failed to attach data-mid", {
        chatId,
        targetMid,
        attempt: i + 1,
        error: lastError.message,
      });
    }

    if (i < attempts - 1) {
      await sleep(90 + i * 30);
    }
  }

  logger.warn("Unable to attach data-mid to DOM message after max attempts", {
    chatId,
    targetMid,
    attempts,
    lastError: lastError?.message,
  });
  return false;
}

/**
 * Seeds `data-mid` attributes for the newest DOM messages in a thread by
 * matching the same-size DB tail by index (oldest->newest within the window).
 */
export async function attachDataMidsForRecentWindow(
  chatId: string,
  windowSize = 8,
): Promise<number> {
  if (!isTargetChatOpen(chatId)) {
    return 0;
  }

  const attempts = 5;
  let maxStamped = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const page = getPage();
      const groups = page
        .locator(SELECTORS.messageList)
        .locator(SELECTORS.messageGroup);

      const groupCount = await groups.count();
      const dbMessages = getLatestMessages(chatId, windowSize);
      const take = Math.min(windowSize, groupCount, dbMessages.length);

      if (!take) {
        if (attempt < attempts - 1) {
          await sleep(100);
        }
        continue;
      }

      const domStart = groupCount - take;
      const dbSlice = dbMessages.slice(-take);
      let stamped = 0;

      for (let i = 0; i < take; i++) {
        const mid = dbSlice[i]?.messageId;
        if (!mid) continue;

        const group = groups.nth(domStart + i);
        try {
          const currentMid = await group.getAttribute("data-mid", {
            timeout: 3000,
          });
          if (currentMid === mid) {
            stamped++;
            continue;
          }

          await group.evaluate(
            (el, resolvedMid) => {
              el.setAttribute("data-mid", resolvedMid);
            },
            mid,
            { timeout: 3000 },
          );
          stamped++;
        } catch (elemErr) {
          logger.debug("Failed to stamp element", {
            chatId,
            index: i,
            error: (elemErr as Error).message,
          });
        }
      }

      if (stamped > 0) {
        maxStamped = Math.max(maxStamped, stamped);
      }

      if (stamped === take) {
        logger.info("Initialised data-mid map for recent thread window", {
          chatId,
          windowSize,
          mapped: take,
          stamped,
          attempt: attempt + 1,
        });
        return take;
      }

      if (attempt < attempts - 1) {
        await sleep(100 + attempt * 30);
      }
    } catch (err) {
      logger.debug("Attempt failed to map data-mids", {
        chatId,
        attempt: attempt + 1,
        error: (err as Error).message,
      });
      if (attempt < attempts - 1) {
        await sleep(100);
      }
    }
  }

  if (maxStamped > 0) {
    logger.warn("Partially initialised data-mid map", {
      chatId,
      windowSize,
      stamped: maxStamped,
      attempts,
    });
  } else {
    logger.error("Unable to initialise any data-mid mappings", {
      chatId,
      windowSize,
      attempts,
    });
  }

  return maxStamped;
}

/**
 * Bulk-stamps `data-mid` on the last `limit` DOM message groups using
 * positional alignment against the DB message window. Call this after
 * navigating to a chat so that pre-existing messages are labelled before
 * any passive-monitoring snapshot is taken.
 */
export async function stampInitialDataMids(
  chatId: string,
  limit: number,
): Promise<void> {
  if (!isTargetChatOpen(chatId)) {
    return;
  }

  const page = getPage();
  const messageList = page.locator(SELECTORS.messageList);
  const allGroups = messageList.locator(SELECTORS.messageGroup);

  let stamped = 0;
  const attempts = 4;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const groupCount = await allGroups.count();
    if (!groupCount) {
      if (attempt < attempts - 1) {
        await sleep(100);
        continue;
      }
      logger.warn("No message groups found after retries", { chatId });
      return;
    }

    const dbMessages = getLatestMessages(chatId, limit);
    const take = Math.min(limit, groupCount, dbMessages.length);
    if (!take) {
      if (attempt < attempts - 1) {
        await sleep(100);
        continue;
      }
      logger.warn("No DB messages available", { chatId });
      return;
    }

    const dbSlice = dbMessages.slice(-take);
    const domStart = groupCount - take;
    stamped = 0;

    for (let i = 0; i < take; i++) {
      const group = allGroups.nth(domStart + i);
      try {
        const existing = await group.getAttribute("data-mid", { timeout: 2000 });
        if (existing === dbSlice[i].messageId) {
          stamped++;
          continue;
        }

        const mid = dbSlice[i].messageId;
        await group.evaluate((el, m) => el.setAttribute("data-mid", m), mid, {
          timeout: 2000,
        });
        stamped++;
      } catch (err) {
        logger.debug("Failed to stamp data-mid on element", {
          chatId,
          index: i,
          error: (err as Error).message,
        });
      }
    }

    if (stamped === take) {
      logger.info("Successfully stamped initial data-mids", {
        chatId,
        stamped,
        targetCount: take,
      });
      return;
    }

    if (attempt < attempts - 1) {
      await sleep(100);
    }
  }

  if (stamped > 0) {
    logger.warn("Partially stamped initial data-mids", {
      chatId,
      stamped,
    });
  } else {
    logger.error("Failed to stamp any initial data-mids", { chatId });
  }
}

/**
 * Returns newest `limit` message groups from the currently open thread,
 * preserving oldest->newest order.
 */
export async function getRecentDomMessages(
  limit: number,
): Promise<DomMessageSnapshot[]> {
  const page = getPage();
  const groups = page
    .locator(SELECTORS.messageList)
    .locator(SELECTORS.messageGroup);

  const count = await groups.count();
  if (!count || limit <= 0) return [];

  const start = Math.max(0, count - limit);
  const results: DomMessageSnapshot[] = [];

  for (let i = start; i < count; i++) {
    const group = groups.nth(i);
    const mid = await group
      .getAttribute("data-mid", { timeout: 5000 })
      .catch(() => null);
    const text = await group
      .evaluate((el, textSelector) => {
        const all = Array.from(el.querySelectorAll(textSelector));

        const leaves = all.filter((n) => !n.querySelector(textSelector));

        const cleaned = leaves.filter((n) => {
          const t = (n.textContent ?? "").trim();

          if (/^.{0,50}\breplied to\b/i.test(t)) return false;
          return true;
        });

        return cleaned
          .map((n) => (n.textContent ?? "").trim())
          .filter(Boolean)
          .join(" ")
          .trim();
      }, SELECTORS.messageText)
      .catch(() => "");

    if (!text) continue;
    results.push({ mid, text });
  }

  return results;
}

async function resolveTargetContainer(
  chatId: string,
  targetMid: string,
): Promise<Locator | null> {
  const firstTry = await findMessageContainer(chatId, targetMid);
  if (firstTry) return firstTry;

  const targetMessage = getMessageByMid(targetMid);
  const ageMs = targetMessage?.timestampMs
    ? Date.now() - Number(targetMessage.timestampMs)
    : null;

  if (ageMs !== null && ageMs > TARGET_MAX_AGE_MS) {
    logger.warn("Skipping action: target message too old", {
      chatId,
      targetMid,
      ageMs,
      cutoffMs: TARGET_MAX_AGE_MS,
    });
    return null;
  }

  // Try one recovery scroll before giving up.
  const page = getPage();
  const messageList = page.locator(SELECTORS.messageList).first();
  try {
    await messageList.evaluate((el) => {
      if (el instanceof HTMLElement) {
        el.scrollBy(0, -300);
      }
    });
  } catch {
    await page.mouse.wheel(0, -300);
  }

  await sleep(150);

  const secondTry = await findMessageContainer(chatId, targetMid);
  if (!secondTry) {
    logger.warn("Target permanently not found in DOM — skipping action", {
      chatId,
      targetMid,
      ageMs,
    });
    return null;
  }

  return secondTry;
}

/* ------------------------------------------------ */
/* Send message                                      */
/* ------------------------------------------------ */

export async function selectToReply(
  chatId?: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    if (!chatId || !targetMid) return true;

    const attempts = 3;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const msg = await resolveTargetContainer(chatId, targetMid);

      if (!msg) {
        logger.warn("Target message not found", {
          targetMid,
          attempt,
          attempts,
        });
        return false;
      }

      try {
        await msg.scrollIntoViewIfNeeded();
      } catch (err) {
        logger.debug("Failed to scroll target message into view", {
          targetMid,
          attempt,
          error: (err as Error).message,
        });
      }

      if (!(await hover(msg))) {
        logger.warn("Target message hover failed", {
          targetMid,
          attempt,
          attempts,
        });
        await sleep(100);
        continue;
      }

      const replyBtn = msg.locator(SELECTORS.replyButton).first();

      if (await click(replyBtn)) {
        logger.info("Reply mode activated", { targetMid, attempt });
        return true;
      }

      logger.warn("Reply button not found", {
        targetMid,
        attempt,
        attempts,
      });
      await sleep(100);
    }

    return false;
  } catch (err) {
    logger.warn("Reply setup failed", {
      error: (err as Error).message,
    });
    return false;
  }
}

export async function sendText(
  text: string,
  chatId: string,
  targetMid?: string,
  options: { appendBotTag?: boolean } = {},
): Promise<boolean> {
  try {
    const page = getPage();
    const conversation = getConversationById(chatId);
    const trimmedText = text.trim();
    const shouldAppendBotTag = options.appendBotTag ?? true;
    const outgoingText =
      !shouldAppendBotTag
        ? trimmedText
        : conversation?.isGroup === true ||
            trimmedText.toUpperCase().endsWith("@BOT")
        ? text
        : trimmedText.length
          ? `${trimmedText} @BOT`
          : "@BOT";

    const replyReady = await selectToReply(chatId, targetMid);
    if (targetMid && !replyReady) {
      logger.warn("Skipping text send: reply target unavailable", {
        chatId,
        targetMid,
      });
      return false;
    }

    const input = page.locator(SELECTORS.messageInput).first();

    if (!(await visible(input))) {
      logger.warn("Message input not found");
      return false;
    }

    await input.click();
    await input.fill(outgoingText);
    await input.press("Enter");

    logger.info("Text message sent", {
      length: outgoingText.length,
      reply: !!targetMid,
      botTagAttached:
        shouldAppendBotTag && conversation?.isGroup !== true,
    });
    return true;
  } catch (err) {
    logger.warn("Send text failed", {
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * Opens media dialog and switches to the specified tab
 */
async function openMediaTab(
  page: Page,
  tabIndex: number,
): Promise<Locator | null> {
  const mediaButton = page.locator(SELECTORS.mediaButton).first();

  if (!(await click(mediaButton))) {
    logger.warn("Media button not found");
    return null;
  }

  const mediaDialog = page.locator(SELECTORS.dialog).first();
  const mediaTabList = mediaDialog.locator(SELECTORS.tabList).first();
  const tab = mediaTabList.locator(SELECTORS.mediaTabButton).nth(tabIndex);

  if (!(await click(tab))) {
    logger.warn(`Media tab ${tabIndex} not found`);
    return null;
  }

  return mediaDialog;
}

async function closeMediaByFocusingComposer(page: Page): Promise<void> {
  const input = page.locator(SELECTORS.messageInput).first();

  if (!(await visible(input, 2000))) {
    logger.warn("Cannot close media tab via message input: input not visible");
    return;
  }

  try {
    await input.click({ timeout: 2000 });
  } catch (err) {
    logger.warn("Failed to close media tab via message input", {
      error: (err as Error).message,
    });
  }
}

/**
 * Sanitizes media search query
 */
function sanitizeMediaTitle(title: string): string {
  return title
    .replace("media", "")
    .replace("meme", "")
    .replace("gif", "")
    .replace("sticker", "")
    .replace("media:", "")
    .replace("_", " ")
    .trim();
}

/**
 * Searches and selects a random media item
 */
async function searchAndSelectMedia(
  mediaDialog: Locator,
  searchInputSelector: string,
  title: string,
  maxRandomIndex: number,
): Promise<boolean> {
  const searchInput = mediaDialog.locator(searchInputSelector).first();

  if (!(await visible(searchInput))) {
    logger.warn(`Search input not found: ${searchInputSelector}`);
    return false;
  }

  await searchInput.fill(sanitizeMediaTitle(title));
  const items = mediaDialog.locator(SELECTORS.mediaItemButton);
  try {
    await items.first().waitFor({ state: "visible", timeout: 3500 });
  } catch {
    return false;
  }

  const count = await items.count();
  const cap = maxRandomIndex > 0 ? Math.min(maxRandomIndex, count) : count;

  for (let i = 0; i < cap; i++) {
    if (await click(items.nth(i))) return true;
  }

  return false;
}

export async function sendSticker(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    const page = getPage();
    const replyReady = await selectToReply(chatId, targetMid);
    if (targetMid && !replyReady) return false;

    const mediaDialog = await openMediaTab(page, 0);
    if (!mediaDialog) return false;

    const success = await searchAndSelectMedia(
      mediaDialog,
      SELECTORS.stickerSearchInput,
      title,
      4,
    );

    if (success) {
      logger.info("Sticker sent", { title, reply: !!targetMid });
      return true;
    } else {
      logger.warn("No sticker results found for title", { title });
      return false;
    }
  } catch (err) {
    logger.warn("Send Sticker failed", {
      error: (err as Error).message,
    });
    return false;
  }
}

export async function sendGIF(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    const page = getPage();
    const replyReady = await selectToReply(chatId, targetMid);
    if (targetMid && !replyReady) return false;

    const mediaDialog = await openMediaTab(page, 1);
    if (!mediaDialog) return false;

    const success = await searchAndSelectMedia(
      mediaDialog,
      SELECTORS.gifSearchInput,
      title,
      6,
    );

    if (success) {
      logger.info("GIF sent", { title, reply: !!targetMid });
      return true;
    } else {
      logger.warn("No GIF results found for title", { title });
      return false;
    }
  } catch (err) {
    logger.warn("Send GIF failed", {
      error: (err as Error).message,
    });
    return false;
  }
}

export async function sendStickerOrGIF(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    const page = getPage();
    const replyReady = await selectToReply(chatId, targetMid);
    if (targetMid && !replyReady) return false;

    // Try sticker first
    let mediaDialog = await openMediaTab(page, 0);
    if (!mediaDialog) return false;

    let success = await searchAndSelectMedia(
      mediaDialog,
      SELECTORS.stickerSearchInput,
      title,
      4,
    );

    if (success) {
      logger.info("Sticker sent", { title, reply: !!targetMid });
      return true;
    }

    // Fallback to GIF by switching tab in the already open media dialog.
    const mediaTabList = mediaDialog.locator(SELECTORS.tabList).first();
    const gifTab = mediaTabList.locator(SELECTORS.mediaTabButton).nth(1);

    if (!(await click(gifTab))) {
      logger.warn("Media tab 1 not found");
      return false;
    }

    success = await searchAndSelectMedia(
      mediaDialog,
      SELECTORS.gifSearchInput,
      title,
      6,
    );

    if (success) {
      logger.info("GIF sent (fallback)", { title, reply: !!targetMid });
      return true;
    } else {
      logger.warn("No sticker or GIF results found", { title });
      return false;
    }
  } catch (err) {
    logger.warn("sendStickerOrGIF failed", { error: (err as Error).message });
    return false;
  }
}

export async function playMusic(query: string): Promise<boolean> {
  try {
    const page = getPage();

    let mediaDialog = await openMediaTab(page, 2);
    if (!mediaDialog) return false;

    let success = await searchAndSelectMedia(
      mediaDialog,
      SELECTORS.musicSearchInput,
      query,
      0,
    );

    if (success) {
      const musicSendBtn = mediaDialog
        .locator(SELECTORS.musicSendButton)
        .first();

      if (!(await click(musicSendBtn))) {
        logger.warn("Music send button not found");
        return false;
      }
    } else {
      await closeMediaByFocusingComposer(page);
      logger.warn("No music results found for query", { query });
      return false;
    }

    logger.info("Music track played", { query });
    return true;
  } catch (err) {
    logger.warn("Play music failed", {
      error: (err as Error).message,
    });
    return false;
  }
}

export async function sendVoiceNote(
  text: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    const page = getPage();
    const replyReady = await selectToReply(chatId, targetMid);
    if (targetMid && !replyReady) return false;

    const composer = page.locator(SELECTORS.messageComposer).first();
    if (!(await visible(composer))) {
      logger.warn("Message composer not found");
      return false;
    }

    const micBtn = composer.locator(SELECTORS.voiceNoteButton).first();
    const sendBtn = composer.locator(SELECTORS.sendVoiceNoteButton).first();

    const buffer = await generateSpeechBuffer(text);

    const metadata = await parseBuffer(buffer);
    const durationMs = Math.ceil((metadata.format.duration || 2) * 1000) + 300;

    if (!(await click(micBtn))) {
      logger.warn("Failed to click voice note button");
      return false;
    }

    await page.waitForTimeout(200);

    playBuffer(buffer);

    await page.waitForTimeout(durationMs);

    if (!(await click(sendBtn))) {
      logger.warn("Failed to click voice note button to stop recording");
      return false;
    }

    logger.info("Voice note sent", { text, reply: !!targetMid });
    return true;
  } catch (err) {
    logger.warn("Send voice note failed", {
      error: (err as Error).message,
    });
    return false;
  }
}

/* ------------------------------------------------ */
/* Add reaction                                      */
/* ------------------------------------------------ */

export async function addReaction(
  reactionEmoji: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    if (!chatId || !targetMid) return false;

    const page = getPage();

    const msg = await resolveTargetContainer(chatId, targetMid);
    if (!msg) {
      logger.warn("Target message not found", { targetMid });
      return false;
    }

    if (!(await hover(msg))) return false;

    const reactBtn = msg.locator(SELECTORS.reactButton).first();

    if (!(await click(reactBtn))) {
      logger.warn("React button not found", { targetMid });
      return false;
    }

    logger.info("Clicked react button", { targetMid });

    /* QUICK REACTION DIALOG */

    const quickPicker = page.locator('[role="dialog"]').last();

    if (!(await visible(quickPicker))) {
      logger.warn("Quick reaction dialog not found");
      return false;
    }

    const quickReaction = quickPicker
      .locator(`span:has-text("${reactionEmoji}")`)
      .first();

    if (await click(quickReaction)) {
      logger.info("Selected quick emoji reaction", { reactionEmoji });
      return true;
    }

    /* OPEN FULL PICKER */

    const chooseEmojiBtn = quickPicker
      .locator(SELECTORS.chooseEmojiButton)
      .first();

    if (!(await click(chooseEmojiBtn))) {
      logger.warn("Choose emoji button not found");
      return false;
    }

    logger.info("Opened full emoji picker");

    /* FULL PICKER */

    const fullPicker = page.locator('[role="dialog"]').last();

    if (!(await visible(fullPicker))) {
      logger.warn("Full emoji picker not found");
      return false;
    }

    const emojiSearchInput = fullPicker
      .locator(SELECTORS.emojiSearchInput)
      .first();

    if (await visible(emojiSearchInput)) {
      const emojiName = find(reactionEmoji)?.key;

      logger.info("Resolved emoji name", {
        reactionEmoji,
        emojiName,
      });

      if (emojiName) {
        await emojiSearchInput.fill(emojiName);
      }
    }

    const pickerEmoji = fullPicker
      .locator(`div[role="button"] span:has-text("${reactionEmoji}")`)
      .first();

    if (await click(pickerEmoji)) {
      logger.info("Selected emoji reaction via full picker", { reactionEmoji });
      return true;
    }

    logger.warn("Emoji not found in picker", { reactionEmoji });
    return false;
  } catch (err) {
    logger.warn("Reaction failed", {
      error: (err as Error).message,
    });
    return false;
  }
}
