import type { Locator, Page } from "playwright-core";
import { find } from "node-emoji";
import { getPage } from "@/automation/session.js";
import { getLatestMessages, getMessageByMid } from "@/db/queries/messages.js";
import SELECTORS from "@/instagram/selectors.js";
import logger from "@/utils/logger.js";
import { sleep } from "@/utils/delay.js";
import { generateSpeechBuffer } from "@/runtime/tts.js";

const TARGET_MAX_AGE_MS = 20_000;

export interface DomMessageSnapshot {
  mid: string | null;
  text: string;
}

function isTargetChatOpen(chatId: string): boolean {
  try {
    return getPage().url().includes(`/direct/t/${chatId}`);
  } catch {
    return false;
  }
}

async function visible(locator: Locator): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible" });
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

async function click(locator: Locator): Promise<boolean> {
  if (!(await visible(locator))) return false;
  try {
    await locator.click({ timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

async function hover(locator: Locator): Promise<boolean> {
  if (!(await visible(locator))) return false;
  try {
    await locator.hover({ timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

async function findMessageContainer(
  chatId: string,
  targetMid?: string,
): Promise<Locator | null> {
  const page = getPage();

  if (targetMid) {
    const escaped = targetMid.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const byMid = page.locator(`[data-mid="${escaped}"]`).first();
    if ((await byMid.count()) > 0) return byMid;
  }

  const allGroups = page
    .locator(SELECTORS.messageList)
    .locator(SELECTORS.messageGroup);
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
    try {
      if (await allGroups.nth(i).isVisible())
        domGroups.unshift(allGroups.nth(i));
    } catch {}
  }

  if (domGroups.length < take) {
    domGroups.length = 0;
    for (let i = groupCount - take; i < groupCount; i++)
      domGroups.push(allGroups.nth(i));
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
  await container.evaluate(
    (el, mid) => el.setAttribute("data-mid", mid),
    targetMid,
  );
}

export async function attachDataMidToDOM(
  chatId: string,
  targetMid: string,
): Promise<boolean> {
  if (!isTargetChatOpen(chatId)) return false;

  let lastError: Error | null = null;
  for (let i = 0; i < 5; i++) {
    try {
      const container = await findMessageContainer(chatId, targetMid);
      if (container) {
        await setDataMidOnContainer(container, targetMid);
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
    if (i < 4) await sleep(90 + i * 30);
  }

  logger.warn("Unable to attach data-mid to DOM message after max attempts", {
    chatId,
    targetMid,
    attempts: 5,
    lastError: lastError?.message,
  });
  return false;
}

export async function attachDataMidsForRecentWindow(
  chatId: string,
  windowSize = 8,
): Promise<number> {
  if (!isTargetChatOpen(chatId)) return 0;

  let maxStamped = 0;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const page = getPage();
      const groups = page
        .locator(SELECTORS.messageList)
        .locator(SELECTORS.messageGroup);
      const groupCount = await groups.count();
      const dbMessages = getLatestMessages(chatId, windowSize);
      const take = Math.min(windowSize, groupCount, dbMessages.length);

      if (!take) {
        if (attempt < 4) await sleep(100);
        continue;
      }

      const domStart = groupCount - take;
      const dbSlice = dbMessages.slice(-take);
      let stamped = 0;

      await Promise.all(
        Array.from({ length: take }, async (_, i) => {
          const mid = dbSlice[i]?.messageId;
          if (!mid) return;
          const group = groups.nth(domStart + i);
          try {
            const currentMid = await group.getAttribute("data-mid", {
              timeout: 3000,
            });
            if (currentMid === mid) {
              stamped++;
              return;
            }
            await group.evaluate(
              (el, m) => el.setAttribute("data-mid", m),
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
        }),
      );

      if (stamped > 0) maxStamped = Math.max(maxStamped, stamped);

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

      if (attempt < 4) await sleep(100 + attempt * 30);
    } catch (err) {
      logger.debug("Attempt failed to map data-mids", {
        chatId,
        attempt: attempt + 1,
        error: (err as Error).message,
      });
      if (attempt < 4) await sleep(100);
    }
  }

  if (maxStamped > 0) {
    logger.warn("Partially initialised data-mid map", {
      chatId,
      windowSize,
      stamped: maxStamped,
      attempts: 5,
    });
  } else {
    logger.error("Unable to initialise any data-mid mappings", {
      chatId,
      windowSize,
      attempts: 5,
    });
  }

  return maxStamped;
}

export async function stampInitialDataMids(
  chatId: string,
  limit: number,
): Promise<void> {
  if (!isTargetChatOpen(chatId)) return;

  const page = getPage();
  const allGroups = page
    .locator(SELECTORS.messageList)
    .locator(SELECTORS.messageGroup);
  let stamped = 0;

  for (let attempt = 0; attempt < 4; attempt++) {
    const groupCount = await allGroups.count();
    if (!groupCount) {
      if (attempt < 3) {
        await sleep(100);
        continue;
      }
      logger.warn("No message groups found after retries", { chatId });
      return;
    }

    const dbMessages = getLatestMessages(chatId, limit);
    const take = Math.min(limit, groupCount, dbMessages.length);
    if (!take) {
      if (attempt < 3) {
        await sleep(100);
        continue;
      }
      logger.warn("No DB messages available", { chatId });
      return;
    }

    const dbSlice = dbMessages.slice(-take);
    const domStart = groupCount - take;
    stamped = 0;

    await Promise.all(
      Array.from({ length: take }, async (_, i) => {
        const group = allGroups.nth(domStart + i);
        try {
          const existing = await group.getAttribute("data-mid", {
            timeout: 2000,
          });
          if (existing === dbSlice[i].messageId) {
            stamped++;
            return;
          }
          await group.evaluate(
            (el, m) => el.setAttribute("data-mid", m),
            dbSlice[i].messageId,
            { timeout: 2000 },
          );
          stamped++;
        } catch (err) {
          logger.debug("Failed to stamp data-mid on element", {
            chatId,
            index: i,
            error: (err as Error).message,
          });
        }
      }),
    );

    if (stamped === take) {
      logger.info("Successfully stamped initial data-mids", {
        chatId,
        stamped,
        targetCount: take,
      });
      return;
    }

    if (attempt < 3) await sleep(100);
  }

  if (stamped > 0) {
    logger.warn("Partially stamped initial data-mids", { chatId, stamped });
  } else {
    logger.error("Failed to stamp any initial data-mids", { chatId });
  }
}

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
    const [mid, text] = await Promise.all([
      group.getAttribute("data-mid", { timeout: 5000 }).catch(() => null),
      group
        .evaluate((el, textSelector) => {
          const all = Array.from(el.querySelectorAll(textSelector));
          const leaves = all.filter((n) => !n.querySelector(textSelector));
          return leaves
            .filter(
              (n) =>
                !/^.{0,50}\breplied to\b/i.test((n.textContent ?? "").trim()),
            )
            .map((n) => (n.textContent ?? "").trim())
            .filter(Boolean)
            .join(" ")
            .trim();
        }, SELECTORS.messageText)
        .catch(() => ""),
    ]);

    if (text) results.push({ mid, text });
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

  const page = getPage();
  const messageList = page.locator(SELECTORS.messageList).first();
  try {
    await messageList.evaluate((el) => {
      if (el instanceof HTMLElement) el.scrollBy(0, -300);
    });
  } catch {
    await page.mouse.wheel(0, -300);
  }

  await sleep(150);

  const secondTry = await findMessageContainer(chatId, targetMid);
  if (!secondTry)
    logger.warn("Target permanently not found in DOM — skipping action", {
      chatId,
      targetMid,
      ageMs,
    });
  return secondTry ?? null;
}

export async function selectToReply(
  chatId?: string,
  targetMid?: string,
): Promise<boolean> {
  if (!chatId || !targetMid) return true;
  try {
    const msg = await resolveTargetContainer(chatId, targetMid);
    if (!msg) {
      logger.warn("Target message not found", { targetMid });
      return false;
    }
    if (!(await hover(msg))) {
      logger.warn("Target message hover failed", { targetMid });
      return false;
    }

    const replyBtn = msg.locator(SELECTORS.replyButton).first();
    if (await click(replyBtn)) {
      logger.info("Reply mode activated", { targetMid });
      return true;
    }

    logger.warn("Reply button not found", { targetMid });
    return false;
  } catch (err) {
    logger.warn("Reply setup failed", { error: (err as Error).message });
    return false;
  }
}

function sanitizeMediaTitle(title: string): string {
  return title
    .replace(/\b(media|meme|gif|sticker)\b/gi, "")
    .replace(/media:/gi, "")
    .replace(/_/g, " ")
    .trim();
}

async function openMediaTab(
  page: Page,
  tabIndex: number,
): Promise<Locator | null> {
  const input = page.locator(SELECTORS.messageInput).first();
  if (!(await visible(input))) {
    logger.warn("openMediaTab: message input not visible — composer not ready");
    return null;
  }

  let dialog = page
    .locator(SELECTORS.dialog)
    .filter({ has: page.locator(SELECTORS.tabList) })
    .last();
  const alreadyOpen = await dialog.isVisible().catch(() => false);

  if (!alreadyOpen) {
    const btn = page.locator(SELECTORS.mediaButton).first();
    if (!(await visible(btn))) {
      logger.warn("openMediaTab: media button not visible");
      return null;
    }

    try {
      await btn.click();
    } catch (err) {
      logger.warn("openMediaTab: media button click failed", {
        error: (err as Error).message,
      });
      return null;
    }

    await sleep(200);
    dialog = page
      .locator(SELECTORS.dialog)
      .filter({ has: page.locator(SELECTORS.tabList) })
      .last();
    if (!(await visible(dialog))) {
      logger.warn(
        "openMediaTab: dialog did not appear after media button click",
      );
      return null;
    }
  }

  const tabList = dialog.locator(SELECTORS.tabList).first();
  if (!(await visible(tabList))) {
    logger.warn("openMediaTab: tab list not visible inside dialog", {
      tabIndex,
    });
    return null;
  }

  const tab = tabList.locator(SELECTORS.mediaTabButton).nth(tabIndex);
  if (!(await visible(tab))) {
    logger.warn("openMediaTab: target tab button not visible", { tabIndex });
    return null;
  }

  try {
    await tab.click({ force: true, timeout: 5000 });
  } catch {
    logger.warn(
      "openMediaTab: tab click failed with force: true. Trying dispatchEvent.",
      { tabIndex },
    );
    try {
      await tab.dispatchEvent("click");
    } catch (dispatchErr) {
      logger.warn("openMediaTab: dispatchEvent click also failed", {
        tabIndex,
        error: (dispatchErr as Error).message,
      });
      return null;
    }
  }

  await sleep(200);

  const panelReady = dialog
    .locator(
      [
        SELECTORS.stickerSearchInput,
        SELECTORS.gifSearchInput,
        SELECTORS.musicSearchInput,
        SELECTORS.mediaItemButton,
      ].join(", "),
    )
    .first();
  if (!(await visible(panelReady))) {
    logger.warn("openMediaTab: tab panel content never appeared", { tabIndex });
    return null;
  }

  logger.info("openMediaTab: ready", { tabIndex });
  return dialog;
}

async function closeMediaByFocusingComposer(page: Page): Promise<void> {
  const input = page.locator(SELECTORS.messageInput).first();
  if (!(await visible(input))) {
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

async function searchAndSelectMedia(
  mediaDialog: Locator,
  searchInputSelector: string,
  title: string,
  maxRandomIndex: number,
): Promise<boolean> {
  const searchInput = mediaDialog.locator(searchInputSelector).first();
  if (!(await visible(searchInput))) {
    logger.warn("searchAndSelectMedia: search input not visible", {
      searchInputSelector,
    });
    return false;
  }

  await searchInput.fill(sanitizeMediaTitle(title));

  const items = mediaDialog.locator(SELECTORS.mediaItemButton);
  let appeared = false;
  
  for (let i = 0; i < 3; i++) {
    if (await visible(items.first())) {
      appeared = true;
      break;
    }
    await sleep(200);
  }

  if (!appeared) {
    logger.warn("searchAndSelectMedia: no results appeared", { title });
    return false;
  }

  await sleep(200)

  const count = await items.count();
  const cap = maxRandomIndex > 0 ? Math.min(maxRandomIndex, count) : count;
  for (let i = 0; i < cap; i++) {
    if (await click(items.nth(i))) return true;
  }
  return false;
}

export async function sendText(
  text: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    const trimmedText = text.trim();
    if (!trimmedText) {
      logger.warn("Skipping text send: empty message", { chatId });
      return false;
    }

    await selectToReply(chatId, targetMid);

    const input = getPage().locator(SELECTORS.messageInput).first();
    if (!(await visible(input))) {
      logger.warn("Message input not found");
      return false;
    }

    await input.click();
    await input.fill(trimmedText);
    await input.press("Enter");

    logger.info("Text message sent", {
      length: trimmedText.length,
      reply: !!targetMid,
    });
    return true;
  } catch (err) {
    logger.warn("Send text failed", { error: (err as Error).message });
    return false;
  }
}

export async function sendSticker(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    const replyReady = await selectToReply(chatId, targetMid);
    if (targetMid && !replyReady) return false;

    const mediaDialog = await openMediaTab(getPage(), 0);
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
    }

    logger.warn("No sticker results found for title", { title });
    return false;
  } catch (err) {
    logger.warn("Send Sticker failed", { error: (err as Error).message });
    return false;
  }
}

export async function sendGIF(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    const replyReady = await selectToReply(chatId, targetMid);
    if (targetMid && !replyReady) return false;

    const mediaDialog = await openMediaTab(getPage(), 1);
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
    }

    logger.warn("No GIF results found for title", { title });
    return false;
  } catch (err) {
    logger.warn("Send GIF failed", { error: (err as Error).message });
    return false;
  }
}

export async function sendStickerOrGIF(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    await selectToReply(chatId, targetMid);

    const page = getPage();
    const mediaDialog = await openMediaTab(page, 0);
    if (!mediaDialog) return false;

    const stickerHit = await searchAndSelectMedia(
      mediaDialog,
      SELECTORS.stickerSearchInput,
      title,
      4,
    );
    if (stickerHit) {
      logger.info("Sticker sent", { title, reply: !!targetMid });
      return true;
    }

    const gifTab = mediaDialog
      .locator(SELECTORS.tabList)
      .first()
      .locator(SELECTORS.mediaTabButton)
      .nth(1);
    if (!(await visible(gifTab))) {
      logger.warn("sendStickerOrGIF: GIF tab not visible");
      return false;
    }

    try {
      await gifTab.click();
    } catch (err) {
      logger.warn("sendStickerOrGIF: GIF tab click failed", {
        error: (err as Error).message,
      });
      return false;
    }

    if (
      !(await visible(mediaDialog.locator(SELECTORS.gifSearchInput).first()))
    ) {
      logger.warn("sendStickerOrGIF: GIF tab panel did not render");
      return false;
    }

    const gifHit = await searchAndSelectMedia(
      mediaDialog,
      SELECTORS.gifSearchInput,
      title,
      6,
    );
    if (gifHit) {
      logger.info("GIF sent (fallback)", { title, reply: !!targetMid });
      return true;
    }

    logger.warn("No sticker or GIF results found", { title });
    return false;
  } catch (err) {
    logger.warn("sendStickerOrGIF failed", { error: (err as Error).message });
    return false;
  }
}

export async function playMusic(query: string): Promise<boolean> {
  try {
    const page = getPage();
    const mediaDialog = await openMediaTab(page, 2);
    if (!mediaDialog) return false;

    logger.info("Opened music tab, searching for track…", { query });

    const found = await searchAndSelectMedia(
      mediaDialog,
      SELECTORS.musicSearchInput,
      query,
      0,
    );
    if (!found) {
      await closeMediaByFocusingComposer(page);
      logger.warn("No music results found for query", { query });
      return false;
    }

    if (
      !(await click(mediaDialog.locator(SELECTORS.musicSendButton).first()))
    ) {
      logger.warn("Music send button not found");
      return false;
    }

    logger.info("Music track played", { query });
    return true;
  } catch (err) {
    logger.warn("Play music failed", { error: (err as Error).message });
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
    const buffer = await generateSpeechBuffer(text);

    await page.evaluate(async (audioData) => {
      const win = window as any;
      if (win.audioContext) {
        try {
          await win.audioContext.close();
        } catch {}
      }
      win.audioContext = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      win.mixedDestination = win.audioContext.createMediaStreamDestination();
      navigator.mediaDevices.getUserMedia = async (constraints) =>
        constraints?.audio ? win.mixedDestination.stream : null;
      await win.audioContext.resume();
      win.currentAudioBuffer = await win.audioContext.decodeAudioData(
        Uint8Array.from(audioData).buffer,
      );
    }, Array.from(buffer));

    await selectToReply(chatId, targetMid);

    const composer = page.locator(SELECTORS.messageComposer).first();
    await page.waitForTimeout(300);

    if (!(await click(composer.locator(SELECTORS.voiceNoteButton).first())))
      return false;
    await page.waitForTimeout(500);

    const durationSec = await page.evaluate(async () => {
      const win = window as any;
      const source = win.audioContext.createBufferSource();
      const gain = win.audioContext.createGain();
      gain.gain.value = 1;
      source.buffer = win.currentAudioBuffer;
      source.connect(gain);
      gain.connect(win.mixedDestination);
      source.start(0);
      return source.buffer.duration;
    });

    await page.waitForTimeout(durationSec * 1000 + 200);

    if (!(await click(composer.locator(SELECTORS.sendVoiceNoteButton).first())))
      return false;

    await page.evaluate(() => {
      (window as any).currentAudioBuffer = null;
    });

    logger.info("Voice note sent successfully");
    return true;
  } catch (err: any) {
    logger.warn("Send voice note failed", { error: err.message });
    return false;
  }
}

export async function addReaction(
  reactionEmoji: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  if (!chatId || !targetMid) return false;
  try {
    const page = getPage();
    const msg = await resolveTargetContainer(chatId, targetMid);
    if (!msg) {
      logger.warn("Target message not found", { targetMid });
      return false;
    }
    if (!(await hover(msg))) return false;

    if (!(await click(msg.locator(SELECTORS.reactButton).first()))) {
      logger.warn("React button not found", { targetMid });
      return false;
    }

    logger.info("Clicked react button", { targetMid });

    const quickPicker = page.locator('[role="dialog"]').last();
    if (!(await visible(quickPicker))) {
      logger.warn("Quick reaction dialog not found");
      return false;
    }

    if (
      await click(
        quickPicker.locator(`span:has-text("${reactionEmoji}")`).first(),
      )
    ) {
      logger.info("Selected quick emoji reaction", { reactionEmoji });
      return true;
    }

    if (
      !(await click(quickPicker.locator(SELECTORS.chooseEmojiButton).first()))
    ) {
      logger.warn("Choose emoji button not found");
      return false;
    }

    logger.info("Opened full emoji picker");

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
      logger.info("Resolved emoji name", { reactionEmoji, emojiName });
      if (emojiName) await emojiSearchInput.fill(emojiName);
    }

    if (
      await click(
        fullPicker
          .locator(`div[role="button"] span:has-text("${reactionEmoji}")`)
          .first(),
      )
    ) {
      logger.info("Selected emoji reaction via full picker", { reactionEmoji });
      return true;
    }

    logger.warn("Emoji not found in picker", { reactionEmoji });
    return false;
  } catch (err) {
    logger.warn("Reaction failed", { error: (err as Error).message });
    return false;
  }
}
