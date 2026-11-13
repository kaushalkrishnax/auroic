import type { Locator, Page } from "playwright-core";
import { find } from "node-emoji";
import { getAssignedPage, requireChatPage } from "@/automation/tabPool.js";
import { getLatestMessages, getMessageByMid } from "@/db/queries/messages.js";
import { getUserByFbid } from "@/db/queries/users.js";
import SELECTORS from "@/instagram/selectors.js";
import logger from "@/utils/logger.js";
import { sleep } from "@/utils/delay.js";
import { generateSpeechBuffer } from "@/runtime/tts.js";
import { getConfig } from "@/runtime/index.js";
import { voiceCaptureInit } from "@/automation/voiceCapture.js";

const TARGET_MAX_AGE_MS = 20_000;
const OUTGOING_POLL_MS = 150;
const TEXT_DELIVERY_TIMEOUT_MS = 8_000;
const MEDIA_DELIVERY_TIMEOUT_MS = 12_000;
const RESULT_REFRESH_TIMEOUT_MS = 8_000;
const MAX_VOICE_TEXT_CHARS = 220;
const MAX_VOICE_DURATION_SEC = 20;

type OutgoingKind = "text" | "sticker" | "gif" | "voice" | "music" | "media";

interface OutgoingRow {
  index: number;
  mid: string | null;
  sender: string | null;
  kind: "text" | "sticker" | "gif" | "voice" | "music";
  text: string;
  key: string;
}

interface OutgoingSnapshot {
  rows: OutgoingRow[];
  ownUsername: string;
}

interface OutgoingExpectation {
  kind: OutgoingKind;
  text?: string;
}

export interface DomMessageSnapshot {
  mid: string | null;
  text: string;
}

function isTargetChatOpen(chatId: string): boolean {
  const page = getAssignedPage(chatId);
  return Boolean(page && page.url().includes(`/direct/t/${chatId}`));
}

async function visible(locator: Locator, timeout = 2500): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

async function click(locator: Locator, timeout = 2500): Promise<boolean> {
  if (!(await visible(locator, timeout))) return false;
  try {
    await locator.click({ timeout });
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

/**
 * Resolves the nearest row wrapper that contains both a message article and
 * that article's "[aria-label="Message actions"]" toolbar, strictly within the
 * message list.
 */
function messageRowOf(messageArticle: Locator): Locator {
  return messageArticle.locator(
    'xpath=ancestor-or-self::*[.//*[@aria-label="Message actions"] and not(@data-pagelet="IGDMessagesList")][1]',
  );
}

async function findMessageContainer(
  chatId: string,
  targetMid?: string,
): Promise<Locator | null> {
  const page = requireChatPage(chatId);
  const conversation = page.locator(SELECTORS.conversation).first();
  const messageList = conversation.locator(SELECTORS.messageList).first();

  if (targetMid) {
    const escaped = targetMid.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const byMid = messageList.locator(`[data-mid="${escaped}"]`).first();
    if ((await byMid.count()) > 0) return byMid;
  }

  const articles = messageList.locator(SELECTORS.messageContainer);
  const count = await articles.count();
  if (!count) {
    logger.warn("No messages found in DOM");
    return null;
  }

  const dbMessages = getLatestMessages(chatId, 10);
  const take = Math.min(10, count, dbMessages.length);
  if (!take) {
    logger.warn("No messages to build window from", {
      count,
      dbCount: dbMessages.length,
    });
    return null;
  }

  const domArticles: Locator[] = [];
  for (let i = count - 1; i >= 0 && domArticles.length < take; i--) {
    try {
      if (await articles.nth(i).isVisible())
        domArticles.unshift(articles.nth(i));
    } catch {}
  }

  if (domArticles.length < take) {
    domArticles.length = 0;
    for (let i = count - take; i < count; i++)
      domArticles.push(articles.nth(i));
  }

  const dbSlice = dbMessages.slice(-take);
  logger.debug("Messages in DB window", { chatId, count: dbSlice.length });

  const index = dbSlice.findIndex((m) => m.messageId === targetMid);
  if (index === -1) {
    logger.warn("Target mid not found in window", { targetMid, chatId });
    return null;
  }

  return messageRowOf(domArticles[index]);
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
      const page = getAssignedPage(chatId);
      if (!page) return 0;
      const conversation = page.locator(SELECTORS.conversation).first();
      const messageList = conversation.locator(SELECTORS.messageList).first();
      const articles = messageList.locator(SELECTORS.messageContainer);
      const groupCount = await articles.count();
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
          const article = articles.nth(domStart + i);
          const group = messageRowOf(article);
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

  const page = getAssignedPage(chatId);
  if (!page) {
    logger.warn("No tab assigned for initial data-mid stamping", { chatId });
    return;
  }
  const conversation = page.locator(SELECTORS.conversation).first();
  const messageList = conversation.locator(SELECTORS.messageList).first();
  const allArticles = messageList.locator(SELECTORS.messageContainer);
  let stamped = 0;

  for (let attempt = 0; attempt < 4; attempt++) {
    const groupCount = await allArticles.count();
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
        const article = allArticles.nth(domStart + i);
        const group = messageRowOf(article);
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
  chatId: string,
  limit: number,
): Promise<DomMessageSnapshot[]> {
  const page = getAssignedPage(chatId);
  if (!page) return [];
  const conversation = page.locator(SELECTORS.conversation).first();
  const messageList = conversation.locator(SELECTORS.messageList).first();
  const articles = messageList.locator(SELECTORS.messageContainer);
  const count = await articles.count();
  if (!count || limit <= 0) return [];

  const start = Math.max(0, count - limit);
  const results: DomMessageSnapshot[] = [];

  for (let i = start; i < count; i++) {
    const article = articles.nth(i);
    const group = messageRowOf(article);
    const [mid, text] = await Promise.all([
      group.getAttribute("data-mid", { timeout: 5000 }).catch(() => null),
      article
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

  const page = requireChatPage(chatId);
  const conversation = page.locator(SELECTORS.conversation).first();
  const messageList = conversation.locator(SELECTORS.messageList).first();
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
    const page = requireChatPage(chatId);
    const conversation = page.locator(SELECTORS.conversation).first();
    const composer = conversation.locator(SELECTORS.messageComposer).first();
    const composerHtmlBefore = await readComposerHtml(composer);

    const row = await resolveTargetContainer(chatId, targetMid);
    if (!row) {
      logger.warn("Target message not found", { targetMid });
      return false;
    }

    if (!(await hover(row))) {
      logger.warn("Target message hover failed", { targetMid });
      return false;
    }

    const actionsGroup = row.locator(SELECTORS.messageActionsGroup);
    let actionsReady = await visible(actionsGroup, 1500);
    if (!actionsReady) {
      const textElem = row.locator(SELECTORS.messageText).first();
      if (await visible(textElem, 500)) {
        await hover(textElem);
      } else {
        await row.dispatchEvent("mouseenter").catch(() => null);
        await row.dispatchEvent("mouseover").catch(() => null);
      }
      actionsReady = await visible(actionsGroup, 1500);
    }

    if (!actionsReady) {
      logger.warn("Message actions group did not appear on hover", {
        targetMid,
      });
      return false;
    }

    const replyBtn = actionsGroup.locator(SELECTORS.replyButton).first();
    if (!(await click(replyBtn))) {
      logger.warn("Reply button not found", { targetMid });
      return false;
    }

    const activated = await isNativeReplyActive(
      page,
      targetMid,
      composerHtmlBefore,
    );
    if (activated) {
      logger.info("Reply mode activated and verified", { targetMid });
      return true;
    }

    logger.warn("Reply button clicked but reply context did not activate", {
      targetMid,
    });
    return false;
  } catch (err) {
    logger.warn("Reply setup failed", { error: (err as Error).message });
    return false;
  }
}

async function clearNativeReplyContext(composer: Locator): Promise<void> {
  const cancelReply = composer
    .locator('[aria-label*="Cancel reply" i], [aria-label*="Remove reply" i]')
    .first();
  if (await click(cancelReply, 1000)) {
    await sleep(100);
    logger.info("Cleared stale native reply context before direct send");
  }
}

export async function openMoreOptions(
  chatId: string,
  targetMid: string,
): Promise<Locator | null> {
  if (!chatId || !targetMid) return null;
  try {
    const page = requireChatPage(chatId);
    const row = await resolveTargetContainer(chatId, targetMid);
    if (!row) {
      logger.warn("Target message not found for more options", { targetMid });
      return null;
    }

    if (!(await hover(row))) {
      logger.warn("Target message hover failed for more options", { targetMid });
      return null;
    }

    const actionsGroup = row.locator(SELECTORS.messageActionsGroup);
    if (!(await visible(actionsGroup))) {
      logger.warn("Message actions group did not appear on hover", {
        targetMid,
      });
      return null;
    }

    const moreBtn = actionsGroup.locator(SELECTORS.moreOptionsButton).first();
    if (!(await click(moreBtn))) {
      logger.warn("More options button not found", { targetMid });
      return null;
    }

    const menu = page.locator('[role="menu"], [role="dialog"]').last();
    if (await visible(menu)) {
      logger.info("More options menu opened", { targetMid });
      return menu;
    }

    logger.warn("More options menu did not appear after click", { targetMid });
    return null;
  } catch (err) {
    logger.warn("Open more options failed", { error: (err as Error).message });
    return null;
  }
}

const MENTION_WAIT_MS = 2_000;
const MENTION_USERNAME_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

async function readComposerText(input: Locator): Promise<string> {
  return input
    .evaluate((el) => {
      const node = el as HTMLElement;
      return node.innerText ?? node.textContent ?? "";
    })
    .catch(() => "");
}

async function readComposerHtml(input: Locator): Promise<string> {
  return input.evaluate((el) => el.innerHTML).catch(() => "");
}

async function focusComposer(input: Locator): Promise<boolean> {
  try {
    if (!(await visible(input))) return false;
    await input.click({ timeout: 2000 });
    return await input
      .evaluate(
        (el) =>
          el === document.activeElement || el.contains(document.activeElement),
      )
      .catch(() => false);
  } catch {
    return false;
  }
}

async function clearComposer(input: Locator): Promise<void> {
  try {
    await input.fill("");
  } catch {
    // Best effort — never throw from a cleanup path.
  }
}

/**
 * Checks whether the native reply context is actually active. We look for the
 * reply preview (cancel-reply control or the target message snippet rendered
 * inside the composer). Returning false here only ever sends the mention
 * fallback, which still delivers the reply, so we deliberately fail closed.
 */
async function isNativeReplyActive(
  page: Page,
  targetMid: string,
  composerHtmlBefore: string,
): Promise<boolean> {
  const targetText = getMessageByMid(targetMid)?.textContent?.trim() ?? "";
  const snippet =
    targetText.length > 24 ? targetText.slice(0, 24) : targetText;
  const composer = page.locator(SELECTORS.messageComposer).first();
  const replyControl = page
    .locator('[aria-label*="Cancel reply" i], [aria-label*="Replying" i]')
    .first();
  const replyText = composer.getByText(/Replying to/i).first();
  const cancelControl = composer
    .locator('[aria-label*="Cancel" i], [aria-label*="Remove" i]')
    .first();

  const deadline = Date.now() + 1500;
  do {
    if (await replyControl.isVisible().catch(() => false)) return true;
    if (await replyText.isVisible().catch(() => false)) return true;
    if (await cancelControl.isVisible().catch(() => false)) return true;

    if (snippet && (await visible(composer))) {
      const previewMatches = await composer
        .evaluate((el, text) => (el.textContent ?? "").includes(text), snippet)
        .catch(() => false);
      if (previewMatches) return true;
    }

    // A successful reply inserts a preview bar above the textbox, changing the
    // composer subtree. An unchanged subtree means the click had no effect.
    const composerHtmlAfter = await readComposerHtml(composer);
    if (
      composerHtmlBefore &&
      composerHtmlAfter &&
      composerHtmlAfter !== composerHtmlBefore
    ) {
      return true;
    }

    await sleep(150);
  } while (Date.now() < deadline);

  return false;
}

/**
 * Gets the username of the message sender for a given message ID.
 */
async function getReplyTargetUsername(
  targetMid: string,
): Promise<string | null> {
  try {
    const message = getMessageByMid(targetMid);
    if (!message) {
      logger.warn("Target message not found in DB", { targetMid });
      return null;
    }
    const user = getUserByFbid(message.userId);
    if (!user?.username) {
      logger.warn("Target user or username not found", {
        userId: message.userId,
        targetMid,
      });
      return null;
    }
    return user.username.trim();
  } catch (err) {
    logger.warn("Failed to get reply target username", {
      targetMid,
      error: (err as Error).message,
    });
    return null;
  }
}

async function waitForMentionDialog(
  page: Page,
  timeoutMs = MENTION_WAIT_MS,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const dialogs = page.locator('div[role="dialog"]:has(> ul > li)');
    const count = await dialogs.count().catch(() => 0);

    for (let i = count - 1; i >= 0; i--) {
      const dialog = dialogs.nth(i);
      if (await dialog.isVisible().catch(() => false)) return dialog;
    }

    await sleep(100);
  } while (Date.now() < deadline);

  return null;
}

/**
 * Returns the topmost li's span whose text is exactly "@username" (or the bare
 * username). Never matches substrings, so "Mention everyone" cannot be picked.
 */
async function findExactMentionSpan(
  dialog: Locator,
  username: string,
): Promise<Locator | null> {
  const listItems = dialog.locator(":scope > ul > li");
  const itemCount = await listItems.count().catch(() => 0);
  const expected = `@${username}`;

  for (let i = 0; i < itemCount; i++) {
    const spans = listItems.nth(i).locator("span");
    const spanCount = await spans.count().catch(() => 0);

    for (let j = 0; j < spanCount; j++) {
      const span = spans.nth(j);
      const text = (
        (await span.textContent({ timeout: 500 }).catch(() => "")) ?? ""
      )
        .replace(/\s+/g, " ")
        .trim();

      if (text === expected || text === username) return span;
    }
  }

  return null;
}

async function waitForMentionSelection(
  dialog: Locator,
  input: Locator,
  username: string,
  htmlBefore: string,
  timeoutMs = MENTION_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const dialogGone = !(await dialog.isVisible().catch(() => false));
    const htmlAfter = await readComposerHtml(input);
    const composerText = await readComposerText(input);
    const hasUsername = composerText.includes(username);

    if (dialogGone && hasUsername && htmlAfter !== htmlBefore) return true;

    await sleep(100);
  } while (Date.now() < deadline);

  return false;
}

/**
 * Instagram rows are often wired to pointer/mouse handlers and the popup can
 * close on blur before a real click lands. Dispatching the full pointer/mouse
 * sequence in one synchronous pass avoids both problems and still triggers
 * React's delegated handlers.
 */
async function dispatchSyntheticClick(target: Locator): Promise<void> {
  await target.evaluate((el) => {
    const init = { bubbles: true, cancelable: true, view: window, button: 0 };
    const MouseCtor = (
      typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent
    ) as typeof MouseEvent;

    for (const type of [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ]) {
      el.dispatchEvent(new MouseCtor(type, init));
    }
  });
}

async function dismissMentionDialog(
  page: Page,
  dialog: Locator | null,
): Promise<void> {
  if (!dialog) return;
  if (!(await dialog.isVisible().catch(() => false))) return;

  try {
    await page.keyboard.press("Escape");
  } catch {
    // Best effort only.
  }

  const deadline = Date.now() + 1000;
  do {
    if (!(await dialog.isVisible().catch(() => false))) return;
    await sleep(75);
  } while (Date.now() < deadline);
}

async function attemptMentionSelection(
  page: Page,
  input: Locator,
  username: string,
  dialog: Locator,
): Promise<boolean> {
  const suggestion = await findExactMentionSpan(dialog, username);
  if (!suggestion) {
    logger.info("Mention fallback: no exact autocomplete match; continuing", {
      username,
    });
    await dismissMentionDialog(page, dialog);
    return false;
  }

  const htmlBefore = await readComposerHtml(input);
  const row = suggestion.locator("xpath=ancestor::li[1]");

  const attempts: Array<{ label: string; run: () => Promise<void> }> = [
    {
      label: "synthetic pointer sequence",
      run: () => dispatchSyntheticClick(suggestion),
    },
    { label: "row click", run: () => row.click({ timeout: 1500 }) },
    {
      label: "forced row click",
      run: () => row.click({ timeout: 1500, force: true }),
    },
  ];

  for (const attempt of attempts) {
    try {
      await attempt.run();
    } catch (err) {
      logger.info("Mention fallback: autocomplete click attempt failed", {
        username,
        attempt: attempt.label,
        error: (err as Error).message,
      });
      continue;
    }

    const selected = await waitForMentionSelection(
      dialog,
      input,
      username,
      htmlBefore,
      1200,
    );
    if (selected) {
      logger.info("Mention fallback: autocomplete suggestion selected", {
        username,
        attempt: attempt.label,
      });
      return true;
    }
  }

  logger.warn(
    "Mention fallback: mention selection not verified; continuing with literal mention",
    { username },
  );
  await dismissMentionDialog(page, dialog);
  return false;
}

/**
 * Guarantees the composer contains the literal "@username " prefix when no
 * autocomplete suggestion was selected. Returns false only if the composer
 * cannot be focused or repopulated.
 */
async function ensureLiteralMention(
  input: Locator,
  username: string,
): Promise<boolean> {
  if (!(await focusComposer(input))) return false;
  await input.press("End");

  const current = await readComposerText(input);
  if (!current.includes(username)) {
    await clearComposer(input);
    if (!(await focusComposer(input))) return false;
    await input.pressSequentially(`@${username} `, { delay: 20 });
    return true;
  }

  if (!/\s$/.test(current)) {
    await input.pressSequentially(" ", { delay: 20 });
  }
  return true;
}

async function waitForComposerCleared(
  input: Locator,
  timeoutMs = 4000,
): Promise<boolean> {
  try {
    return await input.evaluate(
      (el, timeout) =>
        new Promise<boolean>((resolve) => {
          const isEmpty = () => {
            const text = (
              (el as HTMLElement).innerText ??
              el.textContent ??
              ""
            ).trim();
            return !text;
          };
          if (isEmpty()) return resolve(true);

          const observer = new MutationObserver(() => {
            if (isEmpty()) {
              observer.disconnect();
              resolve(true);
            }
          });
          observer.observe(el, {
            childList: true,
            characterData: true,
            subtree: true,
          });

          setTimeout(() => {
            observer.disconnect();
            resolve(isEmpty());
          }, timeout);
        }),
      timeoutMs,
    );
  } catch {
    const deadline = Date.now() + timeoutMs;
    do {
      const text = await readComposerText(input);
      if (!text.trim()) return true;
      await sleep(100);
    } while (Date.now() < deadline);
    return false;
  }
}

function getOwnUsername(): string {
  try {
    return getConfig().instagram.username?.trim() ?? "";
  } catch {
    return "";
  }
}

function normalizeMessageText(value: string): string {
  return value
    .replace(/@BOT/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Snapshot the visible outgoing messages, including their type and a stable
 * identity. Instagram virtualises the message list, so counts are not a valid
 * delivery signal; comparing keys/type/text against a pre-send snapshot is.
 */
async function snapshotOutgoing(page: Page): Promise<OutgoingSnapshot> {
  const ownUsername = getOwnUsername();
  const rows = (await page.evaluate(
    (payload: {
      listSelector: string;
      containerSelector: string;
      textSelector: string;
      actionSelector: string;
      ownUsername: string;
    }) => {
      const list = document.querySelector(payload.listSelector);
      if (!list) return [];
      const listRect = list.getBoundingClientRect();
      const articles = Array.from(
        list.querySelectorAll(payload.containerSelector),
      );
      const result: any[] = [];

      for (let index = 0; index < articles.length; index++) {
        const article = articles[index] as HTMLElement;
        const rect = article.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const action = article.querySelector(payload.actionSelector);
        const rawSender = action?.getAttribute("aria-label") ?? null;
        const sender = rawSender
          ? rawSender.replace(/^React to message from\s+/i, "").trim()
          : null;

        const isOutgoing = payload.ownUsername
          ? sender === payload.ownUsername
          : rect.left + rect.width / 2 > listRect.left + listRect.width / 2;
        if (!isOutgoing) continue;

        let mid: string | null = null;
        for (
          let node: HTMLElement | null = article;
          node && node !== list;
          node = node.parentElement
        ) {
          if (node.hasAttribute("data-mid")) {
            mid = node.getAttribute("data-mid");
            break;
          }
        }

        const leaves = Array.from(
          article.querySelectorAll(payload.textSelector),
        )
          .filter((node) => !node.querySelector(payload.textSelector))
          .map((node) => (node.textContent ?? "").trim())
          .filter(
            (text) => text && !/^.{0,50}\breplied to\b/i.test(text),
          );
        let text = leaves.join(" ").replace(/\s+/g, " ").trim();
        if (!text) {
          text = (article.innerText ?? "")
            .replace(/React to message from.*$/i, "")
            .replace(/Reply to message from.*$/i, "")
            .replace(/See more options for message from.*$/i, "")
            .replace(/\s+/g, " ")
            .trim();
        }

        const waveform = article.querySelector(
          'svg[aria-label*="Waveform" i], [role="slider"][aria-label*="Audio progress" i]',
        );
        const musicMarker = article.querySelector(
          'img[src*="music_sticker_vinyl"], img[src*="/music/"]',
        );
        const video = article.querySelector("video");
        const image = article.querySelector("img");
        const playText = /Play button/i.test(article.innerText ?? "");

        let kind: "text" | "sticker" | "gif" | "voice" | "music" = "text";
        if (waveform) kind = "voice";
        else if (musicMarker || playText) kind = "music";
        else if (video) kind = "gif";
        else if (image) kind = "sticker";

        const media = video ?? image;
        const mediaSource =
          media?.getAttribute("src") || media?.getAttribute("poster") || "";
        const clipId = article.querySelector(
          'svg[aria-label*="Waveform" i] clipPath',
        )?.id;

        const key = mid
          ? `mid:${mid}`
          : kind === "voice"
            ? `voice:${clipId || text || index}`
            : kind === "music"
              ? `music:${text || mediaSource}`
              : kind === "gif"
                ? `gif:${mediaSource || text}`
                : kind === "sticker"
                  ? `sticker:${mediaSource || text}`
                  : `text:${text}`;

        result.push({ index, mid, sender, kind, text, key });
      }

      return result;
    },
    {
      listSelector: SELECTORS.messageList,
      containerSelector: SELECTORS.messageContainer,
      textSelector: SELECTORS.messageText,
      actionSelector: SELECTORS.outgoingMessageAction,
      ownUsername,
    },
  )) as OutgoingRow[];

  return { rows, ownUsername };
}

function matchesExpectation(
  row: OutgoingRow,
  expectation: OutgoingExpectation,
): boolean {
  if (expectation.kind === "media") {
    return row.kind === "gif" || row.kind === "sticker";
  }
  if (row.kind !== expectation.kind) return false;
  if (expectation.kind === "text" && expectation.text) {
    const expected = normalizeMessageText(expectation.text);
    if (!expected) return true;
    return normalizeMessageText(row.text).includes(expected);
  }
  return true;
}

async function waitForOutgoing(
  page: Page,
  before: OutgoingSnapshot,
  expectation: OutgoingExpectation,
  timeoutMs: number,
): Promise<OutgoingRow | null> {
  const deadline = Date.now() + timeoutMs;
  const beforeKeys = new Set(before.rows.map((row) => row.key));
  const beforeMatchCount = before.rows.filter((row) =>
    matchesExpectation(row, expectation),
  ).length;
  let consecutive = 0;
  let lastRow: OutgoingRow | null = null;
  let lastSnapshot: OutgoingSnapshot | null = null;

  while (Date.now() < deadline) {
    lastSnapshot = await snapshotOutgoing(page);
    const matches = lastSnapshot.rows.filter((row) =>
      matchesExpectation(row, expectation),
    );
    const fresh = matches.filter((row) => !beforeKeys.has(row.key));

    let candidate: OutgoingRow | null = null;
    if (fresh.length) {
      candidate = fresh[fresh.length - 1];
    } else if (matches.length > beforeMatchCount) {
      candidate = matches[matches.length - 1];
    } else if (lastSnapshot.rows.length > before.rows.length) {
      const tail = lastSnapshot.rows[lastSnapshot.rows.length - 1];
      if (tail && matchesExpectation(tail, expectation)) candidate = tail;
    }

    if (candidate) {
      const sameCandidate = lastRow
        ? lastRow.key === candidate.key ||
          (lastRow.index === candidate.index &&
            (expectation.kind === "media" ||
              (lastRow.kind === candidate.kind &&
                normalizeMessageText(lastRow.text) ===
                  normalizeMessageText(candidate.text))))
        : false;
      if (sameCandidate) consecutive += 1;
      else consecutive = 1;
      lastRow = candidate;
      if (consecutive >= 2) return candidate;
    } else {
      consecutive = 0;
      lastRow = null;
    }

    await sleep(OUTGOING_POLL_MS);
  }

  logger.warn("Outgoing message was not confirmed in the conversation", {
    expectation,
    beforeCount: before.rows.length,
    beforeMatchCount,
    afterCount: lastSnapshot?.rows.length ?? 0,
    lastRows: lastSnapshot?.rows.slice(-3).map((row) => ({
      kind: row.kind,
      text: row.text.slice(0, 60),
      key: row.key.slice(0, 60),
    })),
  });
  return null;
}

async function verifyTextDelivery(
  page: Page,
  input: Locator,
  before: OutgoingSnapshot,
  expectedText: string,
  timeoutMs = TEXT_DELIVERY_TIMEOUT_MS,
): Promise<boolean> {
  const cleared = await waitForComposerCleared(input, 3000);
  if (!cleared) {
    logger.warn("Composer did not clear after sending message");
    return false;
  }

  const row = await waitForOutgoing(
    page,
    before,
    { kind: "text", text: expectedText },
    timeoutMs,
  );
  return Boolean(row);
}

async function verifyMediaDelivery(
  page: Page,
  before: OutgoingSnapshot,
  kind: OutgoingKind,
  timeoutMs = MEDIA_DELIVERY_TIMEOUT_MS,
): Promise<OutgoingRow | null> {
  return waitForOutgoing(page, before, { kind }, timeoutMs);
}

/**
 * Best-effort mention fallback. Selecting an autocomplete suggestion is
 * preferred because it creates a real mention entity, but any popup failure is
 * recoverable: we still send the literal "@username <reply text>".
 * Only used when the native reply context could not be verified as active.
 */
async function sendTextWithMentionFallback(
  text: string,
  chatId: string,
  targetMid: string,
): Promise<boolean> {
  const page = requireChatPage(chatId);
  const username = await getReplyTargetUsername(targetMid);

  if (!username || !MENTION_USERNAME_PATTERN.test(username)) {
    logger.warn("Mention fallback: missing or invalid username", {
      chatId,
      targetMid,
      username,
    });
    return false;
  }

  const conversation = page.locator(SELECTORS.conversation).first();
  const composer = conversation.locator(SELECTORS.messageComposer).first();
  const input = composer.locator(SELECTORS.messageInput).first();
  if (!(await focusComposer(input))) {
    logger.warn("Mention fallback: composer could not be focused", {
      chatId,
      targetMid,
    });
    return false;
  }

  // Start from a clean composer so the typed mention is unambiguous.
  await clearComposer(input);
  if (!(await focusComposer(input))) {
    logger.warn("Mention fallback: composer lost focus", { chatId, targetMid });
    return false;
  }

  try {
    logger.info("Mention fallback: typing mention", {
      chatId,
      targetMid,
      username,
    });

    // Type the mention while the query is active so Instagram can show
    // autocomplete. If no popup appears, fall through to the literal mention.
    await input.pressSequentially(`@${username}`, { delay: 30 });

    let dialog = await waitForMentionDialog(page, 600);
    if (!dialog) {
      // Keep the desired literal format: "@username " followed by the reply.
      await input.pressSequentially(" ", { delay: 20 });
      dialog = await waitForMentionDialog(page);
    }

    let mentionSelected = false;
    if (dialog) {
      mentionSelected = await attemptMentionSelection(
        page,
        input,
        username,
        dialog,
      );
    } else {
      logger.info(
        "Mention fallback: autocomplete unavailable; sending literal mention",
        { username },
      );
    }

    if (!mentionSelected) {
      if (!(await ensureLiteralMention(input, username))) {
        logger.warn(
          "Mention fallback: could not restore literal mention in composer",
          { username },
        );
        await clearComposer(input);
        return false;
      }
    }

    if (!(await focusComposer(input))) {
      logger.warn("Mention fallback: composer could not be focused for reply", {
        chatId,
        targetMid,
      });
      await clearComposer(input);
      return false;
    }

    await input.press("End");
    let currentText = await readComposerText(input);

    // Safety net: if the mention vanished, rebuild the literal prefix so the
    // reply still starts with "@username".
    if (!currentText.includes(username)) {
      if (!(await ensureLiteralMention(input, username))) {
        logger.warn(
          "Mention fallback: could not restore literal mention before reply",
          { username },
        );
        await clearComposer(input);
        return false;
      }
      await input.press("End");
      currentText = await readComposerText(input);
    }

    const separator = currentText && !/\s$/.test(currentText) ? " " : "";

    // insertText preserves an existing mention entity instead of replacing it.
    await page.keyboard.insertText(`${separator}${text}`);

    const composed = await readComposerText(input);
    if (!composed.includes(text)) {
      logger.warn("Mention fallback: reply text was not inserted", {
        username,
      });
      await clearComposer(input);
      return false;
    }

    const before = await snapshotOutgoing(page);

    await input.press("Enter");

    const verified = await verifyTextDelivery(page, input, before, text);
    if (!verified) {
      logger.warn("Mention fallback: send could not be verified", {
        chatId,
        targetMid,
        username,
      });
      await clearComposer(input);
      return false;
    }

    logger.info("Mention fallback: reply sent and verified", {
      chatId,
      targetMid,
      username,
      mentionSelected,
      length: text.length,
    });
    return true;
  } catch (err) {
    logger.warn("Mention fallback failed", {
      chatId,
      targetMid,
      error: (err as Error).message,
    });
    await clearComposer(input);
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

async function robustClick(
  locator: Locator,
  timeout = 4000,
): Promise<boolean> {
  if (!(await visible(locator, timeout))) return false;

  try {
    await locator.scrollIntoViewIfNeeded({ timeout });
  } catch {
    // The element may already be fully visible.
  }

  try {
    await locator.click({ timeout, noWaitAfter: true });
    return true;
  } catch {
    // Fall through to DOM-dispatched clicks for fixed/offscreen pickers.
  }

  try {
    await locator.dispatchEvent("click");
    return true;
  } catch {
    // Fall through to the full pointer sequence.
  }

  try {
    await locator.evaluate((element) => {
      const el = element as HTMLElement;
      el.scrollIntoView({ block: "center", inline: "center" });
      for (const type of [
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click",
      ]) {
        const EventCtor = type.startsWith("pointer")
          ? PointerEvent
          : MouseEvent;
        el.dispatchEvent(
          new EventCtor(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
          }),
        );
      }
      el.click?.();
    });
    return true;
  } catch {
    return false;
  }
}

function mediaDialog(page: Page): Locator {
  return page.locator(SELECTORS.mediaDialog).last();
}

async function isMediaDialogOpen(page: Page): Promise<boolean> {
  return visible(mediaDialog(page), 250);
}

/**
 * State-aware picker opener. A picker can be open while `aria-expanded` is
 * false, and clicking the composer toggle while it is open closes it. The only
 * reliable state is the visible dialog that contains a tab list.
 *
 * Tabs are identified by the search-panel placeholder they reveal
 * ("Search stickers" / "Search GIPHY" / "Search music"), not by index:
 * Instagram mounts the music tab late and can briefly expose only two tabs,
 * which makes fixed indices unreliable.
 */
type MediaKind = "sticker" | "giphy" | "music";

const MEDIA_TAB_INDEX: Record<MediaKind, number> = {
  sticker: 0,
  giphy: 1,
  music: 2,
};

async function mediaPanelMatches(
  dialog: Locator,
  keyword: MediaKind,
): Promise<boolean> {
  const input = dialog.locator(SELECTORS.gifSearchInput).first();
  if (!(await visible(input, 300))) return false;
  const placeholder =
    (await input.getAttribute("placeholder").catch(() => null)) ?? "";
  return placeholder.toLowerCase().includes(keyword);
}

async function selectMediaPanel(
  dialog: Locator,
  keyword: MediaKind,
): Promise<boolean> {
  if (await mediaPanelMatches(dialog, keyword)) return true;

  const tabs = dialog.locator(SELECTORS.mediaTab);
  const preferred = MEDIA_TAB_INDEX[keyword];

  // The music tab mounts late; wait briefly for the preferred tab to exist.
  let count = await tabs.count();
  const mountDeadline = Date.now() + 4000;
  while (count <= preferred && Date.now() < mountDeadline) {
    await sleep(150);
    count = await tabs.count();
  }

  const order: number[] = [];
  if (count > preferred) order.push(preferred);
  for (let i = 0; i < Math.max(count, 1); i++) {
    if (!order.includes(i)) order.push(i);
  }

  for (const index of order) {
    const tab = tabs.nth(index);
    if (!(await visible(tab, 1000))) continue;
    if (!(await robustClick(tab))) continue;

    // A cold picker panel can take several seconds to mount. Stay on this tab
    // until the panel reports the expected placeholder instead of cycling
    // through tabs and interrupting its load.
    const panelDeadline = Date.now() + 6000;
    while (Date.now() < panelDeadline) {
      if (await mediaPanelMatches(dialog, keyword)) return true;
      await sleep(150);
    }
  }

  return mediaPanelMatches(dialog, keyword);
}

async function openMediaTab(
  page: Page,
  kind: MediaKind,
): Promise<Locator | null> {
  const conversation = page.locator(SELECTORS.conversation).first();
  const composer = conversation.locator(SELECTORS.messageComposer).first();

  let dialog = mediaDialog(page);
  const alreadyOpen = await visible(dialog, 250);

  if (!alreadyOpen) {
    const toggle = composer.locator(SELECTORS.gifStickerButton).first();
    if (!(await visible(toggle, 3000))) {
      logger.warn("openMediaTab: GIF/sticker button not visible");
      return null;
    }
    if (!(await robustClick(toggle))) {
      logger.warn("openMediaTab: could not open the media picker");
      return null;
    }

    const openDeadline = Date.now() + 8000;
    while (Date.now() < openDeadline) {
      dialog = mediaDialog(page);
      if (await visible(dialog, 200)) break;
      await sleep(100);
    }
  }

  if (!(await visible(dialog, 1000))) {
    logger.warn("openMediaTab: dialog did not appear after toggle");
    await closeMediaDialog(page);
    return null;
  }

  const tabList = dialog.locator(SELECTORS.mediaTabList).first();
  if (!(await visible(tabList, 5000))) {
    logger.warn("openMediaTab: tab list not visible inside dialog", { kind });
    await closeMediaDialog(page);
    return null;
  }

  const ready = await selectMediaPanel(dialog, kind);
  if (!ready) {
    const placeholder = await dialog
      .locator(SELECTORS.gifSearchInput)
      .first()
      .getAttribute("placeholder")
      .catch(() => null);
    logger.warn("openMediaTab: requested panel never became ready", {
      kind,
      tabCount: await dialog.locator(SELECTORS.mediaTab).count(),
      placeholder,
    });
    await closeMediaDialog(page);
    return null;
  }

  logger.info("openMediaTab: ready", { kind, alreadyOpen });
  return dialog;
}

async function closeMediaDialog(page: Page): Promise<void> {
  if (!(await isMediaDialogOpen(page))) return;

  const conversation = page.locator(SELECTORS.conversation).first();
  const composer = conversation.locator(SELECTORS.messageComposer).first();
  const input = composer.locator(SELECTORS.messageInput).first();

  if (await visible(input, 1000)) {
    await robustClick(input, 1500);
  }

  if (await isMediaDialogOpen(page)) {
    await page.keyboard.press("Escape").catch(() => null);
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await isMediaDialogOpen(page))) {
    await sleep(100);
  }

  if (await isMediaDialogOpen(page)) {
    logger.warn("Media picker remained open after cleanup");
  }
}

/**
 * Compact fingerprint of the currently rendered results. Instagram replaces
 * sticker categories with search results (443 -> 40 tiles) and reflows GIF
 * results in place without changing their count, so geometry and media URLs
 * must be part of the signature.
 */
async function mediaResultFingerprint(mediaDialog: Locator): Promise<string> {
  return mediaDialog
    .locator(SELECTORS.mediaItemButton)
    .evaluateAll((elements) => {
      let hash = 2166136261;
      const mix = (value: string) => {
        for (let i = 0; i < value.length; i++) {
          hash ^= value.charCodeAt(i);
          hash = Math.imul(hash, 16777619);
        }
      };

      for (const element of elements) {
        const rect = (element as HTMLElement).getBoundingClientRect();
        const media = element.querySelector(
          "img,video",
        ) as HTMLImageElement | HTMLVideoElement | null;
        mix(
          [
            Math.round(rect.x),
            Math.round(rect.y),
            Math.round(rect.width),
            Math.round(rect.height),
            element.getAttribute("aria-label") ?? "",
            media?.getAttribute("src") ?? "",
            media?.getAttribute("poster") ?? "",
          ].join("|"),
        );
      }

      return `${elements.length}:${(hash >>> 0).toString(36)}`;
    });
}

async function waitForResultsChanged(
  mediaDialog: Locator,
  before: string,
  timeoutMs = RESULT_REFRESH_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let previous = before;
  let changed = false;
  let stable = 0;

  while (Date.now() < deadline) {
    const current = await mediaResultFingerprint(mediaDialog);
    if (current !== before) changed = true;

    if (changed && current === previous) {
      stable += 1;
      if (stable >= 2) return true;
    } else {
      stable = 0;
    }

    previous = current;
    await sleep(150);
  }

  return changed;
}

async function searchAndSelectMedia(
  mediaDialog: Locator,
  searchInputSelector: string,
  title: string,
  maxRandomIndex: number,
): Promise<boolean> {
  const searchInput = mediaDialog.locator(searchInputSelector).first();
  if (!(await visible(searchInput, 3000))) {
    logger.warn("searchAndSelectMedia: search input not visible", {
      searchInputSelector,
    });
    return false;
  }

  const query = sanitizeMediaTitle(title) || title.trim() || "funny";
  const before = await mediaResultFingerprint(mediaDialog);

  await searchInput.fill(query);

  const placeholder =
    (await searchInput.getAttribute("placeholder").catch(() => null)) ?? "";
  if (/giphy/i.test(placeholder)) {
    await searchInput.press("Enter").catch(() => null);
  }

  const refreshed = await waitForResultsChanged(mediaDialog, before);
  if (!refreshed) {
    logger.warn("searchAndSelectMedia: results did not visibly refresh", {
      title,
      query,
    });
  }

  const items = mediaDialog.locator(SELECTORS.mediaItemButton);
  try {
    await items.first().waitFor({ state: "visible", timeout: 6000 });
  } catch {
    logger.warn("searchAndSelectMedia: no results appeared", { title, query });
    return false;
  }

  const count = await items.count();
  if (!count) {
    logger.warn("searchAndSelectMedia: no result tiles found", { title });
    return false;
  }

  const cap = maxRandomIndex > 0 ? Math.min(maxRandomIndex, count) : count;
  for (let i = 0; i < cap; i++) {
    if (await robustClick(items.nth(i))) return true;
  }

  logger.warn("searchAndSelectMedia: could not select any result tile", {
    title,
    count,
    cap,
  });
  return false;
}

async function selectMusicTrack(
  mediaDialog: Locator,
  query: string,
): Promise<boolean> {
  const rows = mediaDialog
    .locator(SELECTORS.musicTrackRow)
    .filter({ hasText: /\d:\d\d/ });

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if ((await rows.count()) > 0) break;
    await sleep(150);
  }

  const count = await rows.count();
  if (!count) {
    logger.warn("selectMusicTrack: no tracks found", { query });
    return false;
  }

  const tokens = sanitizeMediaTitle(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 1);

  let targetIndex = 0;
  for (let i = 0; i < Math.min(count, 8); i++) {
    const text = (await rows.nth(i).innerText().catch(() => "")).toLowerCase();
    if (tokens.some((token) => text.includes(token))) {
      targetIndex = i;
      break;
    }
  }

  return robustClick(rows.nth(targetIndex));
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

    const page = requireChatPage(chatId);
    const conversation = page.locator(SELECTORS.conversation).first();
    const composer = conversation.locator(SELECTORS.messageComposer).first();
    const input = composer.locator(SELECTORS.messageInput).first();

    // If no targetMid, just send as normal message (no reply)
    if (!targetMid) {
      if (!(await visible(input))) {
        logger.warn("Message input not found");
        return false;
      }

      const before = await snapshotOutgoing(page);

      await input.click();
      await input.fill(trimmedText);
      await input.press("Enter");

      const verified = await verifyTextDelivery(
        page,
        input,
        before,
        trimmedText,
      );
      if (!verified) {
        logger.warn("Text message send could not be verified", { chatId });
        return false;
      }

      logger.info("Text message sent and verified", {
        length: trimmedText.length,
        reply: false,
      });
      return true;
    }

    // Try native reply first. If it cannot be activated, send the text
    // directly instead of replacing delivery with a mention fallback.
    const nativeReplyActivated = await selectToReply(chatId, targetMid);

    if (!nativeReplyActivated) {
      logger.warn("Native reply unavailable; sending text directly", {
        chatId,
        targetMid,
      });
      await clearNativeReplyContext(composer);
      return sendText(trimmedText, chatId);
    }

    if (!(await visible(input))) {
      logger.warn("Message input not visible after native reply; sending directly", {
        chatId,
        targetMid,
      });
      await clearNativeReplyContext(composer);
      return sendText(trimmedText, chatId);
    }

    const before = await snapshotOutgoing(page);

    await input.click();
    await input.fill(trimmedText);
    await input.press("Enter");

    const verified = await verifyTextDelivery(
      page,
      input,
      before,
      trimmedText,
    );
    if (!verified) {
      logger.warn(
        "Text message sent via native reply could not be verified",
        { chatId, targetMid },
      );
      return false;
    }

    logger.info("Text message sent via native reply and verified", {
      length: trimmedText.length,
      reply: true,
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
  let page: Page | null = null;
  let mediaDialog: Locator | null = null;

  try {
    page = requireChatPage(chatId);
    let replyReady = false;
    if (targetMid) {
      replyReady = await selectToReply(chatId, targetMid);
      if (!replyReady) {
        await clearNativeReplyContext(
          page.locator(SELECTORS.messageComposer).first(),
        );
        logger.warn("sendSticker: reply unavailable; sending directly", {
          targetMid,
          chatId,
        });
      }
    }

    mediaDialog = await openMediaTab(page, "sticker");
    if (!mediaDialog) return false;

    const before = await snapshotOutgoing(page);
    const selected = await searchAndSelectMedia(
      mediaDialog,
      SELECTORS.stickerSearchInput,
      title,
      4,
    );
    if (!selected) {
      logger.warn("No sticker results found for title", { title });
      return false;
    }

    const delivered = await verifyMediaDelivery(page, before, "sticker");
    if (!delivered) {
      logger.warn("Sticker selected but delivery was not confirmed", {
        title,
        chatId,
      });
      return false;
    }

    logger.info("Sticker sent and verified", {
      title,
      reply: replyReady,
      key: delivered.key.slice(0, 60),
    });
    return true;
  } catch (err) {
    logger.warn("Send Sticker failed", { error: (err as Error).message });
    return false;
  } finally {
    if (page && mediaDialog) {
      await closeMediaDialog(page).catch(() => undefined);
    }
  }
}

/**
 * Opens the GIF/sticker picker from the composer, selects the GIF tab (the
 * second tab — stickers are selected by default) and confirms it is the
 * selected tab before returning the dialog locator.
 */
async function openGifPicker(page: Page): Promise<Locator | null> {
  return openMediaTab(page, "giphy");
}

/**
 * Enters a query, waits for the GIF result grid to refresh, and selects the
 * first result. Some builds close the dialog immediately; others expose a
 * confirmation send control — both are handled, but the caller still verifies
 * the resulting conversation message.
 */
async function searchAndSelectGif(
  mediaDialog: Locator,
  title: string,
): Promise<boolean> {
  const selected = await searchAndSelectMedia(
    mediaDialog,
    SELECTORS.gifSearchInput,
    title,
    0,
  );
  if (!selected) return false;

  const sendButton = mediaDialog
    .locator('div[role="button"][aria-label="Send"]')
    .first();
  if (await visible(sendButton, 750)) {
    await robustClick(sendButton);
  }

  return true;
}

async function sendGifLike(
  title: string,
  chatId: string,
  targetMid: string | undefined,
  label: string,
): Promise<boolean> {
  let page: Page | null = null;
  let mediaDialog: Locator | null = null;

  try {
    page = requireChatPage(chatId);
    let replyReady = false;
    if (targetMid) {
      replyReady = await selectToReply(chatId, targetMid);
      if (!replyReady) {
        await clearNativeReplyContext(
          page.locator(SELECTORS.messageComposer).first(),
        );
        logger.warn(`${label}: reply unavailable; sending directly`, {
          targetMid,
          chatId,
        });
      }
    }

    mediaDialog = await openGifPicker(page);
    if (!mediaDialog) return false;

    const before = await snapshotOutgoing(page);
    const selected = await searchAndSelectGif(mediaDialog, title);
    if (!selected) {
      logger.warn(`${label}: no GIF result could be selected`, { title });
      return false;
    }

    const delivered = await verifyMediaDelivery(page, before, "media");
    if (!delivered) {
      logger.warn(`${label}: delivery was not confirmed`, {
        title,
        chatId,
      });
      return false;
    }

    logger.info(`${label}: sent and verified`, {
      title,
      reply: replyReady,
      kind: delivered.kind,
      key: delivered.key.slice(0, 60),
    });
    return true;
  } catch (err) {
    logger.warn(`${label} failed`, { error: (err as Error).message });
    return false;
  } finally {
    if (page && mediaDialog) {
      await closeMediaDialog(page).catch(() => undefined);
    }
  }
}

export async function sendGIF(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  return sendGifLike(title, chatId, targetMid, "sendGIF");
}

export async function sendStickerOrGIF(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  return sendGifLike(title, chatId, targetMid, "sendStickerOrGIF");
}

export async function playMusic(
  query: string,
  chatId: string,
): Promise<boolean> {
  let page: Page | null = null;
  let mediaDialog: Locator | null = null;

  try {
    page = requireChatPage(chatId);
    mediaDialog = await openMediaTab(page, "music");
    if (!mediaDialog) return false;

    const searchInput = mediaDialog
      .locator(SELECTORS.gifSearchInput)
      .first();
    if (!(await visible(searchInput, 3000))) {
      logger.warn("playMusic: music search input not visible");
      return false;
    }

    const searchQuery = sanitizeMediaTitle(query) || query.trim();
    logger.info("playMusic: searching for track", { query, searchQuery });

    const fingerprintBefore = await mediaResultFingerprint(mediaDialog);
    await searchInput.fill(searchQuery);

    const refreshed = await waitForResultsChanged(
      mediaDialog,
      fingerprintBefore,
    );
    if (!refreshed) {
      logger.warn("playMusic: music results did not visibly refresh", {
        query,
        searchQuery,
      });
    }

    const before = await snapshotOutgoing(page);

    const trackSelected = await selectMusicTrack(mediaDialog, searchQuery);
    if (!trackSelected) {
      logger.warn("playMusic: could not select a music track", {
        query,
        searchQuery,
      });
      return false;
    }

    // Selecting a track only starts the preview; the send arrow lives in the
    // floating player toolbar at the bottom of the picker.
    const sendButton = mediaDialog
      .locator(SELECTORS.musicSendButton)
      .last();
    if (!(await visible(sendButton, 5000))) {
      logger.warn("playMusic: send arrow not visible in the music player", {
        query,
      });
      return false;
    }

    if (!(await robustClick(sendButton))) {
      logger.warn("playMusic: could not click the music send arrow", {
        query,
      });
      return false;
    }

    const delivered = await verifyMediaDelivery(page, before, "music");
    if (!delivered) {
      logger.warn("playMusic: music delivery was not confirmed", {
        query,
        chatId,
      });
      return false;
    }

    logger.info("Music track sent and verified", {
      query,
      key: delivered.key.slice(0, 60),
    });
    return true;
  } catch (err) {
    logger.warn("Play music failed", { error: (err as Error).message });
    return false;
  } finally {
    if (page && mediaDialog) {
      await closeMediaDialog(page).catch(() => undefined);
    }
  }
}

async function readVoiceTimerSeconds(composer: Locator): Promise<number> {
  const text =
    (await composer
      .locator(SELECTORS.voiceTimer)
      .first()
      .innerText()
      .catch(() => "")) ?? "";
  const match = text.match(/(\d+):(\d{2})/);
  if (!match) return -1;
  return Number(match[1]) * 60 + Number(match[2]);
}

async function getVoiceCaptureState(page: Page): Promise<{
  recorderState: string | null;
  recordingStreamId: string | null;
  captureStreamId: string | null;
  captureRequests: number;
  destinationStreamId: string | null;
  chunks: number;
  lastChunkSize: number;
  peak: number;
  sourcePlaying: boolean;
} | null> {
  return page
    .evaluate(() => {
      const voice = (window as any).__auroicVoice;
      return voice ? voice.getState() : null;
    })
    .catch(() => null);
}

async function cancelVoiceRecording(
  composer: Locator,
  reason: string,
): Promise<void> {
  const cancelButton = composer.locator(SELECTORS.voiceCancelButton).first();
  if (!(await visible(cancelButton, 1000))) return;
  logger.warn("Cancelling voice recording", { reason });
  await robustClick(cancelButton);
}

/**
 * Waits until the injected audio has actually finished playing into the
 * recorder and Instagram shows a non-zero recording duration. This is a
 * condition-based wait: the source ends deterministically, so there is no need
 * to guess a fixed recording duration.
 */
async function waitForVoiceRecordingReady(
  page: Page,
  composer: Locator,
  expectedDurationSec: number,
): Promise<boolean> {
  const timeoutMs = expectedDurationSec * 1000 + 6000;
  const deadline = Date.now() + timeoutMs;
  let lastChunkGrowth = false;
  let previousChunks = 0;

  while (Date.now() < deadline) {
    const state = await getVoiceCaptureState(page);
    const timerSeconds = await readVoiceTimerSeconds(composer);

    if (state) {
      if (state.chunks > previousChunks) lastChunkGrowth = true;
      previousChunks = state.chunks;

      const sourceFinished = !state.sourcePlaying;
      const hasAudio =
        state.chunks > 0 ? lastChunkGrowth : state.peak > 0.002;
      const recorderOk =
        state.recorderState === null || state.recorderState === "recording";
      if (
        sourceFinished &&
        hasAudio &&
        timerSeconds >= 1 &&
        recorderOk
      ) {
        return true;
      }
    }

    await sleep(150);
  }

  const state = await getVoiceCaptureState(page);
  logger.warn("Voice recording did not reach a sendable state", {
    expectedDurationSec,
    timerSeconds: await readVoiceTimerSeconds(composer),
    state,
  });
  return false;
}

/**
 * Submits the voice preview if Instagram asks for a second confirmation.
 * Only clicks controls inside the composer/preview — never the composer text
 * send button used for normal messages.
 */
async function submitVoicePreview(page: Page): Promise<boolean> {
  const conversation = page.locator(SELECTORS.conversation).first();
  const composer = conversation.locator(SELECTORS.messageComposer).first();
  const dialog = mediaDialog(page);

  for (const scope of [composer, dialog]) {
    const button = scope
      .locator('div[role="button"][aria-label="Send"]')
      .first();
    if (await visible(button, 750)) {
      if (await robustClick(button)) return true;
    }
  }
  return false;
}

export async function sendVoiceNote(
  text: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  let page: Page | null = null;

  try {
    page = requireChatPage(chatId);
    const conversation = page.locator(SELECTORS.conversation).first();
    const composer = conversation.locator(SELECTORS.messageComposer).first();
    const input = composer.locator(SELECTORS.messageInput).first();

    try {
      await page.bringToFront();
    } catch {
      // Best effort; recording works while backgrounded on some builds.
    }

    // The session init script covers future navigations; evaluate it here as
    // well so an already-loaded document is patched before the recorder is
    // created. Both calls are idempotent.
    await page.evaluate(voiceCaptureInit);

    const bridge = await page.evaluate(async () => {
      const voice = (window as any).__auroicVoice;
      if (!voice) return { ok: false as const };
      await voice.ensure();
      voice.resetRecorder();
      return { ok: true as const, ...voice.getState() };
    });
    if (!bridge.ok || !bridge.destinationStreamId) {
      logger.warn("sendVoiceNote: voice capture bridge unavailable", {
        chatId,
        bridge,
      });
      return false;
    }

    const spokenText = text.trim().slice(0, MAX_VOICE_TEXT_CHARS);
    if (!spokenText) {
      logger.warn("Skipping voice note: empty text", { chatId });
      return false;
    }

    const buffer = await generateSpeechBuffer(spokenText);

    const decoded = await page.evaluate(
      async (bytes: number[]) => {
        const voice = (window as any).__auroicVoice;
        return voice.decode(bytes);
      },
      Array.from(buffer),
    );
    if (
      !decoded ||
      !Number.isFinite(decoded.duration) ||
      decoded.duration < 0.2
    ) {
      logger.warn("sendVoiceNote: generated audio could not be decoded", {
        chatId,
        duration: decoded?.duration,
      });
      return false;
    }
    if (decoded.duration > MAX_VOICE_DURATION_SEC) {
      // The text is capped, so this indicates an unexpected TTS response.
      logger.warn("sendVoiceNote: generated audio exceeds the voice cap", {
        chatId,
        duration: decoded.duration,
        limit: MAX_VOICE_DURATION_SEC,
      });
      return false;
    }

    // Instagram Web silently drops a voice note while a native reply context is
    // active: clicking Send clears the composer but issues no upload/send
    // request. Verified live with the synthetic TTS stream and with Chromium's
    // native fake microphone, replying to both own and incoming messages.
    // Voice notes therefore always go out as direct messages; a stale reply
    // banner must be cleared or the note is silently discarded.
    if (targetMid) {
      logger.info("sendVoiceNote: sending without native reply context", {
        targetMid,
        chatId,
        reason: "Instagram Web drops voice notes while replying",
      });
    }
    await clearNativeReplyContext(composer);
    await sleep(100);

    // Voice Clip is only exposed while the composer is empty.
    await input.fill("").catch(() => null);
    await sleep(150);

    const before = await snapshotOutgoing(page);

    const voiceButton = composer.locator(SELECTORS.voiceNoteButton).first();
    if (!(await visible(voiceButton, 3000))) {
      logger.warn("Voice note button not visible in composer", { chatId });
      return false;
    }
    if (!(await robustClick(voiceButton))) {
      logger.warn("Could not start voice recording", { chatId });
      return false;
    }

    const stopButton = composer.locator(SELECTORS.voiceStopButton).first();
    const recordingStarted = await visible(stopButton, 6000);
    if (!recordingStarted) {
      logger.warn("Recording did not start after clicking the voice button", {
        chatId,
      });
      return false;
    }

    // Instagram can capture through MediaRecorder or through its own WebAudio
    // graph fed by `getUserMedia`. In both cases the bridge must be the source:
    // either the recorder's stream or the stream handed to getUserMedia must be
    // the AudioContext destination. Otherwise the native fake mic is recording.
    let recorder = await getVoiceCaptureState(page);
    const captureDeadline = Date.now() + 2000;
    const usingSyntheticStream = () =>
      Boolean(
        recorder?.destinationStreamId &&
          (recorder.recordingStreamId === recorder.destinationStreamId ||
            recorder.captureStreamId === recorder.destinationStreamId),
      );

    while (Date.now() < captureDeadline && !usingSyntheticStream()) {
      await sleep(100);
      recorder = await getVoiceCaptureState(page);
    }

    if (!usingSyntheticStream()) {
      // The capture source is provably wrong: sending would upload the native
      // fake-microphone loop. This is the one safe case for cancelling.
      await cancelVoiceRecording(
        composer,
        "neither MediaRecorder nor getUserMedia used the TTS stream",
      );
      return false;
    }

    await page.evaluate(
      async (bytes: number[]) => {
        const voice = (window as any).__auroicVoice;
        return voice.feed(bytes);
      },
      Array.from(buffer),
    );

    const ready = await waitForVoiceRecordingReady(
      page,
      composer,
      decoded.duration,
    );
    if (!ready) {
      // The recording never became sendable (no timer/chunks), so there is no
      // valid audio to preserve.
      await cancelVoiceRecording(composer, "recording never became sendable");
      return false;
    }

    const sendButton = composer.locator(SELECTORS.sendVoiceNoteButton).first();
    if (!(await visible(sendButton, 4000))) {
      logger.warn("Send button not visible during voice recording", {
        chatId,
      });
      await cancelVoiceRecording(composer, "send button never appeared");
      return false;
    }

    if (!(await robustClick(sendButton))) {
      logger.warn("Could not click Send for the voice note", { chatId });
      await cancelVoiceRecording(composer, "send control could not be clicked");
      return false;
    }

    // Some builds show a preview step; submit it when present.
    await submitVoicePreview(page);

    let delivered = await verifyMediaDelivery(page, before, "voice", 15000);

    if (!delivered) {
      // The recording was verified valid, so retry delivery once explicitly.
      logger.warn(
        "sendVoiceNote: delivery not confirmed after first Send; retrying once",
        { chatId },
      );
      const retried = await submitVoicePreview(page);
      if (!retried) {
        const retrySend = composer
          .locator(SELECTORS.sendVoiceNoteButton)
          .first();
        if (await visible(retrySend, 1500)) {
          await robustClick(retrySend);
        }
      }
      delivered = await verifyMediaDelivery(page, before, "voice", 10000);
    }

    if (!delivered) {
      // Verified-valid recording failed delivery even after one retry. Cancel
      // explicitly so the composer cannot get stuck, but log the reason.
      logger.warn("Voice note delivery failed after retry; cancelling capture", {
        chatId,
      });
      await cancelVoiceRecording(composer, "verified recording failed delivery");
      return false;
    }

    const finalCapture = await getVoiceCaptureState(page);
    logger.info("Voice note sent and verified", {
      chatId,
      reply: false,
      durationSec: decoded.duration,
      textLength: spokenText.length,
      capture: finalCapture
        ? {
            mode: finalCapture.captureRequests > 0 ? "getUserMedia" : "recorder",
            peak: finalCapture.peak,
            chunks: finalCapture.chunks,
          }
        : null,
    });
    return true;
  } catch (err) {
    logger.warn("Send voice note failed", { error: (err as Error).message });
    return false;
  } finally {
    if (page) {
      await page
        .evaluate(() => {
          const voice = (window as any).__auroicVoice;
          if (voice) {
            voice.stopSource();
            voice.resetRecorder();
          }
        })
        .catch(() => undefined);
    }
  }
}

export async function addReaction(
  reactionEmoji: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  if (!chatId || !targetMid) return false;
  try {
    const page = requireChatPage(chatId);
    const row = await resolveTargetContainer(chatId, targetMid);
    if (!row) {
      logger.warn("Target message not found", { targetMid });
      return false;
    }
    if (!(await hover(row))) return false;

    const actionsGroup = row.locator(SELECTORS.messageActionsGroup);
    let actionsReady = await visible(actionsGroup, 1500);
    if (!actionsReady) {
      const textElem = row.locator(SELECTORS.messageText).first();
      if (await visible(textElem, 500)) {
        await hover(textElem);
      } else {
        await row.dispatchEvent("mouseenter").catch(() => null);
        await row.dispatchEvent("mouseover").catch(() => null);
      }
      actionsReady = await visible(actionsGroup, 1500);
    }

    if (!actionsReady) {
      logger.warn("Message actions group did not appear on hover", {
        targetMid,
      });
      return false;
    }

    if (!(await click(actionsGroup.locator(SELECTORS.reactButton).first()))) {
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
      await quickPicker
        .waitFor({ state: "hidden", timeout: 3000 })
        .catch(() => null);
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
      await fullPicker
        .waitFor({ state: "hidden", timeout: 3000 })
        .catch(() => null);
      return true;
    }

    logger.warn("Emoji not found in picker", { reactionEmoji });
    return false;
  } catch (err) {
    logger.warn("Reaction failed", { error: (err as Error).message });
    return false;
  }
}