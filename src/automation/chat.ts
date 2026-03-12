/**
 * Instagram chat interaction helpers.
 * Message targeting uses index-based DOM matching instead of text search.
 */

import type { Locator } from "playwright";
import { getPage } from "@/automation/session.js";
import { getLatestMessages } from "@/db/queries/messages.js";
import SELECTORS from "@/instagram/selectors.js";
import logger from "@/utils/logger.js";
import { find } from "node-emoji";

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

/* ------------------------------------------------ */
/* Send message                                      */
/* ------------------------------------------------ */

export async function selectToReply(
  chatId?: string,
  targetMid?: string,
): Promise<void> {
  try {
    if (!chatId || !targetMid) return;

    const page = getPage();

    const msg = await findMessageContainer(chatId, targetMid);

    if (!msg) {
      logger.warn("Target message not found", { targetMid });
      return;
    }

    if (!(await hover(msg))) return;

    const replyBtn = msg.locator(SELECTORS.replyButton).first();

    if (await click(replyBtn)) {
      logger.info("Reply mode activated", { targetMid });
    } else {
      logger.warn("Reply button not found", { targetMid });
    }
  } catch (err) {
    logger.warn("Reply setup failed", {
      error: (err as Error).message,
    });
  }
}

export async function sendText(
  text: string,
  chatId: string,
  targetMid?: string,
): Promise<void> {
  try {
    const page = getPage();

    await selectToReply(chatId, targetMid);

    const input = page.locator(SELECTORS.messageInput).first();

    if (!(await visible(input))) {
      logger.warn("Message input not found");
      return;
    }

    await input.click();
    await input.fill("");
    await input.pressSequentially(text, { delay: 15 });
    await input.press("Enter");

    logger.info("Text message sent", {
      length: text.length,
      reply: !!targetMid,
    });
  } catch (err) {
    logger.warn("Send text failed", {
      error: (err as Error).message,
    });
  }
}

export async function sendSticker(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<void> {
  try {
    const page = getPage();
    await selectToReply(chatId, targetMid);
    const mediaButton = page.locator(SELECTORS.mediaButton).first();

    if (!(await click(mediaButton))) {
      logger.warn("Media button not found");
      return;
    }

    const mediaDialog = page.locator(SELECTORS.dialog).first();
    const mediaTabList = mediaDialog.locator(SELECTORS.tabList).first();
    const stickerTab = mediaTabList.locator(SELECTORS.mediaTabButton).nth(0);

    if (!(await click(stickerTab))) {
      logger.warn("Sticker tab not found");
      return;
    }

    const searchInput = mediaDialog
      .locator(SELECTORS.stickerSearchInput)
      .first();

    if (!(await visible(searchInput))) {
      logger.warn("Sticker search input not found");
      return;
    }

    await searchInput.fill(title?.replace("media:", "").replace("_", " "));
    const result = mediaDialog
      .locator(SELECTORS.mediaItemButton)
      .nth(Math.floor(Math.random() * 6));

    if (await click(result)) {
      logger.info("Sticker sent", { title, reply: !!targetMid });
    } else {
      logger.warn("No sticker results found for title", { title });
    }
  } catch (err) {
    logger.warn("Send Sticker failed", {
      error: (err as Error).message,
    });
  }
}

/**
 * Try to send a sticker matching `title`. Falls back to a GIF in the same
 * already-open media dialog if no sticker result is found.
 */
export async function sendStickerOrGIF(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<void> {
  try {
    const page = getPage();
    await selectToReply(chatId, targetMid);
    const mediaButton = page.locator(SELECTORS.mediaButton).first();

    if (!(await click(mediaButton))) {
      logger.warn("Media button not found");
      return;
    }

    const mediaDialog = page.locator(SELECTORS.dialog).first();
    const mediaTabList = mediaDialog.locator(SELECTORS.tabList).first();
    const query = title?.replace("media:", "").replace("_", " ");

    // --- try sticker first ---
    const stickerTab = mediaTabList.locator(SELECTORS.mediaTabButton).nth(0);
    if (await click(stickerTab)) {
      const stickerInput = mediaDialog
        .locator(SELECTORS.stickerSearchInput)
        .first();
      if (await visible(stickerInput)) {
        await stickerInput.fill(query);
        const stickerResult = mediaDialog
          .locator(SELECTORS.mediaItemButton)
          .nth(Math.floor(Math.random() * 6));
        if (await click(stickerResult)) {
          logger.info("Sticker sent", { title, reply: !!targetMid });
          return;
        }
        logger.info("No sticker results — falling back to GIF", { title });
      }
    }

    // --- fallback: GIF (dialog is still open) ---
    const gifTab = mediaTabList.locator(SELECTORS.mediaTabButton).nth(1);
    if (!(await click(gifTab))) {
      logger.warn("GIF tab not found during fallback");
      return;
    }
    const gifInput = mediaDialog.locator(SELECTORS.gifSearchInput).first();
    if (!(await visible(gifInput))) {
      logger.warn("GIF search input not found during fallback");
      return;
    }
    await gifInput.fill(query);
    const gifResult = mediaDialog
      .locator(SELECTORS.mediaItemButton)
      .nth(Math.floor(Math.random() * 6));
    if (await click(gifResult)) {
      logger.info("GIF sent (sticker fallback)", { title, reply: !!targetMid });
    } else {
      logger.warn("No GIF results found either", { title });
    }
  } catch (err) {
    logger.warn("sendStickerOrGIF failed", { error: (err as Error).message });
  }
}

export async function sendGIF(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<void> {
  try {
    const page = getPage();
    await selectToReply(chatId, targetMid);
    const mediaButton = page.locator(SELECTORS.mediaButton).first();

    if (!(await click(mediaButton))) {
      logger.warn("Media button not found");
      return;
    }

    const mediaDialog = page.locator(SELECTORS.dialog).first();
    const mediaTabList = mediaDialog.locator(SELECTORS.tabList).first();
    const gifTab = mediaTabList.locator(SELECTORS.mediaTabButton).nth(1);

    if (!(await click(gifTab))) {
      logger.warn("GIF tab not found");
      return;
    }

    const searchInput = mediaDialog.locator(SELECTORS.gifSearchInput).first();

    if (!(await visible(searchInput))) {
      logger.warn("GIF search input not found");
      return;
    }

    await searchInput.fill(title?.replace("media:", "").replace("_", " "));

    const result = mediaDialog
      .locator(SELECTORS.mediaItemButton)
      .nth(Math.floor(Math.random() * 6));

    if (await click(result)) {
      logger.info("GIF sent", { title, reply: !!targetMid });
    } else {
      logger.warn("No GIF results found for title", { title });
    }
  } catch (err) {
    logger.warn("Send GIF failed", {
      error: (err as Error).message,
    });
  }
}

/* ------------------------------------------------ */
/* Add reaction                                      */
/* ------------------------------------------------ */

export async function addReaction(
  reactionEmoji: string,
  chatId: string,
  targetMid?: string,
): Promise<void> {
  try {
    const page = getPage();

    const msg = await findMessageContainer(chatId, targetMid);
    if (!msg) {
      logger.warn("Target message not found", { targetMid });
      return;
    }

    if (!(await hover(msg))) return;

    const reactBtn = msg.locator(SELECTORS.reactButton).first();

    if (!(await click(reactBtn))) {
      logger.warn("React button not found", { targetMid });
      return;
    }

    logger.info("Clicked react button", { targetMid });

    /* QUICK REACTION DIALOG */

    const quickPicker = page.locator('[role="dialog"]').last();

    if (!(await visible(quickPicker))) {
      logger.warn("Quick reaction dialog not found");
      return;
    }

    const quickReaction = quickPicker
      .locator(`span:has-text("${reactionEmoji}")`)
      .first();

    if (await click(quickReaction)) {
      logger.info("Selected quick emoji reaction", { reactionEmoji });
      return;
    }

    /* OPEN FULL PICKER */

    const chooseEmojiBtn = quickPicker
      .locator(SELECTORS.chooseEmojiButton)
      .first();

    if (!(await click(chooseEmojiBtn))) {
      logger.warn("Choose emoji button not found");
      return;
    }

    logger.info("Opened full emoji picker");

    /* FULL PICKER */

    const fullPicker = page.locator('[role="dialog"]').last();

    if (!(await visible(fullPicker))) {
      logger.warn("Full emoji picker not found");
      return;
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
    }
  } catch (err) {
    logger.warn("Reaction failed", {
      error: (err as Error).message,
    });
  }
}
