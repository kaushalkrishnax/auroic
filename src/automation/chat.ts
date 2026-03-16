/**
 * Instagram chat interaction helpers.
 * Message targeting uses index-based DOM matching instead of text search.
 */

import type { Locator, Page } from "playwright";
import { find } from "node-emoji";
import { getPage } from "@/automation/session.js";
import { getConversationById } from "@/db/queries/conversations.js";
import { getLatestMessages, getMessageByMid } from "@/db/queries/messages.js";
import SELECTORS from "@/instagram/selectors.js";
import logger from "@/utils/logger.js";
import { sleep } from "@/utils/delay.js";

const TARGET_MAX_AGE_MS = 20_000;

export interface DomMessageSnapshot {
  mid: string | null;
  text: string;
}

/* ------------------------------------------------ */
/* Helper utilities                                  */
/* ------------------------------------------------ */

async function visible(locator: Locator, timeout = 5000): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

async function click(locator: Locator): Promise<boolean> {
  if (!(await visible(locator))) return false;
  await locator.click();
  return true;
}

async function hover(locator: Locator): Promise<boolean> {
  if (!(await visible(locator))) return false;
  await locator.hover();
  return true;
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
  for (let i = groupCount - take; i < groupCount; i++) {
    domGroups.push(allGroups.nth(i));
  }

  const dbSlice = dbMessages.slice(-take);

  logger.info("Messages in DB window", { count: dbSlice.length });
  logger.info("DB mids in window", { mids: dbSlice.map((m) => m.messageId) });

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
  const attempts = 6;

  for (let i = 0; i < attempts; i++) {
    const container = await findMessageContainer(chatId, targetMid);
    if (container) {
      await setDataMidOnContainer(container, targetMid);
      logger.info("Attached data-mid to DOM message", { chatId, targetMid });
      return true;
    }

    await sleep(150);
  }

  logger.warn("Unable to attach data-mid to DOM message", { chatId, targetMid });
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
  const attempts = 6;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const page = getPage();
    const groups = page
      .locator(SELECTORS.messageList)
      .locator(SELECTORS.messageGroup);

    const groupCount = await groups.count();
    const dbMessages = getLatestMessages(chatId, windowSize);
    const take = Math.min(windowSize, groupCount, dbMessages.length);

    if (!take) {
      await sleep(150);
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
        const currentMid = await group.getAttribute("data-mid", { timeout: 5000 });
        if (currentMid === mid) continue;

        await group.evaluate((el, resolvedMid) => {
          el.setAttribute("data-mid", resolvedMid);
        }, mid, { timeout: 5000 });
      } catch {
        // DOM changed during iteration — break to retry on next attempt
        break;
      }

      stamped++;
    }

    logger.info("Initialised data-mid map for recent thread window", {
      chatId,
      windowSize,
      mapped: take,
      stamped,
    });

    return take;
  }

  logger.warn("Unable to initialise recent data-mid map", {
    chatId,
    windowSize,
  });

  return 0;
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
  const page = getPage();
  const messageList = page.locator(SELECTORS.messageList);
  const allGroups = messageList.locator(SELECTORS.messageGroup);

  const groupCount = await allGroups.count();
  if (!groupCount) return;

  const dbMessages = getLatestMessages(chatId, limit);
  const take = Math.min(limit, groupCount, dbMessages.length);
  if (!take) return;

  const dbSlice = dbMessages.slice(-take);
  const domStart = groupCount - take;

  for (let i = 0; i < take; i++) {
    const group = allGroups.nth(domStart + i);
    try {
      const existing = await group.getAttribute("data-mid", { timeout: 5000 });
      if (existing) continue;
      const mid = dbSlice[i].messageId;
      await group.evaluate((el, m) => el.setAttribute("data-mid", m), mid, { timeout: 5000 });
    } catch {
      // DOM changed, skip this element
    }
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
  const groups = page.locator(SELECTORS.messageList).locator(SELECTORS.messageGroup);

  const count = await groups.count();
  if (!count || limit <= 0) return [];

  const start = Math.max(0, count - limit);
  const results: DomMessageSnapshot[] = [];

  for (let i = start; i < count; i++) {
    const group = groups.nth(i);
    const mid = await group.getAttribute("data-mid", { timeout: 5000 }).catch(() => null);
    const text = await group
      .evaluate(
        (el, textSelector) => {
          const all = Array.from(el.querySelectorAll(textSelector));

          const leaves = all.filter(
            (n) => !n.querySelector(textSelector),
          );

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
        },
        SELECTORS.messageText,
      )
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

  await sleep(500);

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

    const msg = await resolveTargetContainer(chatId, targetMid);

    if (!msg) {
      logger.warn("Target message not found", { targetMid });
      return false;
    }

    if (!(await hover(msg))) return false;

    const replyBtn = msg.locator(SELECTORS.replyButton).first();

    if (await click(replyBtn)) {
      logger.info("Reply mode activated", { targetMid });
      return true;
    } else {
      logger.warn("Reply button not found", { targetMid });
      return false;
    }
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
): Promise<boolean> {
  try {
    const page = getPage();
    const conversation = getConversationById(chatId);
    const trimmedText = text.trim();
    const outgoingText =
      conversation?.isGroup === true || trimmedText.toUpperCase().endsWith("@BOT")
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
      botTagAttached: conversation?.isGroup !== true,
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
  await sleep(2000);

  const result = mediaDialog
    .locator(SELECTORS.mediaItemButton)
    .nth(Math.floor(Math.random() * maxRandomIndex));

  return await click(result);
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

    // Fallback to GIF if sticker fails
    mediaDialog = await openMediaTab(page, 1);
    if (!mediaDialog) return false;

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
