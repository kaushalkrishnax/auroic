import type { Locator, Page } from "playwright-core";
import { find } from "node-emoji";
import { getAssignedPage, requireChatPage } from "@/automation/tabPool.js";
import { getLatestMessages, getMessageByMid } from "@/db/queries/messages.js";
import { getUserByFbid } from "@/db/queries/users.js";
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

async function waitForNewMessage(
  page: Page,
  beforeCount: number,
  timeoutMs = 8000,
): Promise<boolean> {
  try {
    return await page
      .waitForFunction(
        (payload: { listSel: string; itemSel: string; before: number }) => {
          const list = document.querySelector(payload.listSel);
          if (!list) return false;
          return list.querySelectorAll(payload.itemSel).length > payload.before;
        },
        {
          listSel: SELECTORS.messageList,
          itemSel: SELECTORS.messageContainer,
          before: beforeCount,
        },
        { timeout: timeoutMs },
      )
      .then(() => true)
      .catch(() => false);
  } catch {
    return false;
  }
}

async function verifyOutgoingSend(
  page: Page,
  input: Locator,
  beforeCount: number,
  expectedText?: string,
  timeoutMs = 8000,
): Promise<boolean> {
  const cleared = await waitForComposerCleared(input, 3000);
  if (!cleared) {
    logger.warn("Composer did not clear after sending message");
    return false;
  }

  const newMessage = await waitForNewMessage(page, beforeCount, timeoutMs);
  if (!newMessage) {
    logger.warn("New message did not appear in conversation after sending");
    return false;
  }

  return true;
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

    const messageList = conversation.locator(SELECTORS.messageList).first();
    const beforeCount = await messageList
      .locator(SELECTORS.messageContainer)
      .count();

    await input.press("Enter");

    const verified = await verifyOutgoingSend(
      page,
      input,
      beforeCount,
      text,
    );
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

async function openMediaTab(
  page: Page,
  tabIndex: number,
): Promise<Locator | null> {
  const conversation = page.locator(SELECTORS.conversation).first();
  const composer = conversation.locator(SELECTORS.messageComposer).first();
  let dialog = page
    .locator(SELECTORS.gifDialog)
    .filter({ has: page.locator(SELECTORS.mediaTabList) })
    .last();
  const alreadyOpen = await dialog.isVisible().catch(() => false);

  if (!alreadyOpen) {
    const btn = composer.locator(SELECTORS.gifStickerButton).first();
    if (!(await visible(btn, 3000))) {
      logger.warn("openMediaTab: GIF/sticker button not visible");
      return null;
    }

    try {
      await btn.click({ timeout: 4000, noWaitAfter: true });
    } catch (err) {
      logger.warn("openMediaTab: GIF/sticker button click failed, trying dispatchEvent", {
        error: (err as Error).message,
      });
      await btn.dispatchEvent("click").catch(() => null);
    }

    dialog = page
      .locator(SELECTORS.gifDialog)
      .filter({ has: page.locator(SELECTORS.mediaTabList) })
      .last();
    if (!(await visible(dialog, 5000))) {
      logger.warn(
        "openMediaTab: dialog did not appear after GIF/sticker button click",
      );
      return null;
    }
  }

  const tabList = dialog.locator(SELECTORS.mediaTabList).first();
  if (!(await visible(tabList, 5000))) {
    logger.warn("openMediaTab: tab list not visible inside dialog", {
      tabIndex,
    });
    return null;
  }

  const tab = tabList.locator(SELECTORS.mediaTab).nth(tabIndex);
  if (!(await visible(tab, 5000))) {
    logger.warn("openMediaTab: target tab button not visible", { tabIndex });
    return null;
  }

  const isAlreadySelected =
    (await tab.getAttribute("aria-selected").catch(() => null)) === "true";

  if (!isAlreadySelected) {
    try {
      await tab.click({ timeout: 3000, noWaitAfter: true });
    } catch {
      logger.warn("openMediaTab: tab click failed. Trying dispatchEvent.", {
        tabIndex,
      });
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

    const deadline = Date.now() + 3000;
    let selected = false;
    while (Date.now() < deadline) {
      const val = await tab.getAttribute("aria-selected").catch(() => null);
      if (val === "true") {
        selected = true;
        break;
      }
      await sleep(100);
    }

    if (!selected) {
      logger.warn("openMediaTab: tab did not become selected", { tabIndex });
      return null;
    }
  }

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

  if (!(await visible(panelReady, 5000))) {
    logger.warn("openMediaTab: tab panel content never appeared", {
      tabIndex,
    });
    return null;
  }

  logger.info("openMediaTab: ready", { tabIndex });
  return dialog;
}

async function closeMediaByFocusingComposer(page: Page): Promise<void> {
  const conversation = page.locator(SELECTORS.conversation).first();
  const composer = conversation.locator(SELECTORS.messageComposer).first();
  const input = composer.locator(SELECTORS.messageInput).first();
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
  try {
    await items.first().waitFor({ state: "visible", timeout: 6000 });
  } catch {
    logger.warn("searchAndSelectMedia: no results appeared", { title });
    return false;
  }

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

    const page = requireChatPage(chatId);
    const conversation = page.locator(SELECTORS.conversation).first();
    const composer = conversation.locator(SELECTORS.messageComposer).first();
    const input = composer.locator(SELECTORS.messageInput).first();
    const messageList = conversation.locator(SELECTORS.messageList).first();

    // If no targetMid, just send as normal message (no reply)
    if (!targetMid) {
      if (!(await visible(input))) {
        logger.warn("Message input not found");
        return false;
      }

      const beforeCount = await messageList
        .locator(SELECTORS.messageContainer)
        .count();

      await input.click();
      await input.fill(trimmedText);
      await input.press("Enter");

      const verified = await verifyOutgoingSend(
        page,
        input,
        beforeCount,
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

    const beforeCount = await messageList
      .locator(SELECTORS.messageContainer)
      .count();

    await input.click();
    await input.fill(trimmedText);
    await input.press("Enter");

    const verified = await verifyOutgoingSend(
      page,
      input,
      beforeCount,
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
  try {
    const page = requireChatPage(chatId);
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
    const mediaDialog = await openMediaTab(page, 0);
    if (!mediaDialog) return false;

    const conversation = page.locator(SELECTORS.conversation).first();
    const messageList = conversation.locator(SELECTORS.messageList).first();
    const beforeCount = await messageList
      .locator(SELECTORS.messageContainer)
      .count();

    const success = await searchAndSelectMedia(
      mediaDialog,
      SELECTORS.stickerSearchInput,
      title,
      4,
    );
    if (!success) {
      logger.warn("No sticker results found for title", { title });
      return false;
    }

    const verified = await waitForNewMessage(page, beforeCount);
    if (!verified) {
      logger.warn("Sticker selected but did not appear in conversation", {
        title,
        chatId,
      });
      return false;
    }

    logger.info("Sticker sent and verified", { title, reply: replyReady });
    return true;
  } catch (err) {
    logger.warn("Send Sticker failed", { error: (err as Error).message });
    return false;
  }
}

/**
 * Opens the GIF/sticker picker from the composer, selects the GIF tab (the
 * second tab — stickers are selected by default) and confirms it is the
 * selected tab before returning the dialog locator.
 */
async function openGifPicker(page: Page): Promise<Locator | null> {
  return openMediaTab(page, 1);
}

/**
 * Enters a query, waits for GIF results, and selects the first result. A
 * selected GIF either sends immediately (dialog closes) or exposes a
 * confirmation/send control — both paths are handled.
 */
async function searchAndSelectGif(
  mediaDialog: Locator,
  title: string,
): Promise<boolean> {
  const searchInput = mediaDialog.locator(SELECTORS.gifSearchInput).first();
  if (!(await visible(searchInput))) {
    logger.warn("searchAndSelectGif: search input not visible");
    return false;
  }

  await searchInput.fill(sanitizeMediaTitle(title));
  await searchInput.press("Enter");

  // Scope result selection to the visible GIF results inside this dialog —
  // never a page-wide generic button:has(img) search.
  const results = mediaDialog.locator(SELECTORS.mediaItemButton);
  try {
    await results.first().waitFor({ state: "visible", timeout: 6000 });
  } catch {
    logger.warn("searchAndSelectGif: no GIF results appeared", { title });
    return false;
  }

  if (!(await click(results.first()))) {
    logger.warn("searchAndSelectGif: could not select a GIF result", {
      title,
    });
    return false;
  }

  // A selected GIF either sends immediately (dialog closes) or exposes a
  // send control. Handle both without assuming either.
  const sentImmediately = await mediaDialog
    .waitFor({ state: "hidden", timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (sentImmediately) return true;

  const sendButton = mediaDialog
    .locator('div[role="button"][aria-label="Send"], div[role="button"]:has-text("Send")')
    .first();
  if (await visible(sendButton, 2000)) return await click(sendButton);

  return true;
}

export async function sendGIF(
  title: string,
  chatId: string,
  targetMid?: string,
): Promise<boolean> {
  try {
    const page = requireChatPage(chatId);
    let replyReady = false;
    if (targetMid) {
      replyReady = await selectToReply(chatId, targetMid);
      if (!replyReady) {
        await clearNativeReplyContext(
          page.locator(SELECTORS.messageComposer).first(),
        );
        logger.warn("sendGIF: reply unavailable; sending directly", {
          targetMid,
          chatId,
        });
      }
    }
    const mediaDialog = await openGifPicker(page);
    if (!mediaDialog) return false;

    const conversation = page.locator(SELECTORS.conversation).first();
    const messageList = conversation.locator(SELECTORS.messageList).first();
    const beforeCount = await messageList
      .locator(SELECTORS.messageContainer)
      .count();

    const selected = await searchAndSelectGif(mediaDialog, title);
    if (!selected) return false;

    const verified = await waitForNewMessage(page, beforeCount);
    if (!verified) {
      logger.warn("GIF was selected but did not appear in the conversation", {
        title,
        chatId,
      });
      return false;
    }

    logger.info("GIF sent and verified", { title, reply: replyReady });
    return true;
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
    const page = requireChatPage(chatId);
    let replyReady = false;
    if (targetMid) {
      replyReady = await selectToReply(chatId, targetMid);
      if (!replyReady) {
        await clearNativeReplyContext(
          page.locator(SELECTORS.messageComposer).first(),
        );
        logger.warn("sendStickerOrGIF: reply unavailable; sending directly", {
          targetMid,
          chatId,
        });
      }
    }
    const mediaDialog = await openGifPicker(page);
    if (!mediaDialog) return false;

    const conversation = page.locator(SELECTORS.conversation).first();
    const messageList = conversation.locator(SELECTORS.messageList).first();
    const beforeCount = await messageList
      .locator(SELECTORS.messageContainer)
      .count();

    const selected = await searchAndSelectGif(mediaDialog, title);
    if (!selected) return false;

    const verified = await waitForNewMessage(page, beforeCount);
    if (!verified) {
      logger.warn("Sticker/GIF selected but did not appear in conversation", {
        title,
        chatId,
      });
      return false;
    }

    return true;
  } catch (err) {
    logger.warn("Send sticker/GIF failed", { error: (err as Error).message });
    return false;
  }
}

export async function playMusic(
  query: string,
  chatId: string,
): Promise<boolean> {
  try {
    const page = requireChatPage(chatId);
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
    const page = requireChatPage(chatId);

    // Ensure the tab is focused so AudioContext and media capture are active
    try {
      await page.bringToFront();
    } catch {
      // Best effort
    }

    // Grant microphone permission on the browser context
    try {
      await page.context().grantPermissions(["microphone"], {
        origin: "https://www.instagram.com",
      });
    } catch (permErr) {
      logger.debug("Failed to grant microphone permission", {
        error: (permErr as Error).message,
      });
    }

    let replyReady = false;
    if (targetMid) {
      replyReady = await selectToReply(chatId, targetMid);
      if (!replyReady) {
        await clearNativeReplyContext(
          page.locator(SELECTORS.messageComposer).first(),
        );
        logger.warn("sendVoiceNote: reply unavailable; sending directly", {
          targetMid,
          chatId,
        });
      }
    }
    const conversation = page.locator(SELECTORS.conversation).first();
    const composer = conversation.locator(SELECTORS.messageComposer).first();

    // Ensure composer text input is clear so the Voice Clip button is visible
    const input = composer.locator(SELECTORS.messageInput).first();
    const currentText = await readComposerText(input);
    if (currentText.trim().length > 0) {
      await clearComposer(input);
      await page.waitForTimeout(150);
    }

    const buffer = await generateSpeechBuffer(text);

    await page.evaluate(async (audioData) => {
      const win = window as any;
      if (win.audioContext && win.audioContext.state !== "closed") {
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
      if (win.audioContext.state === "suspended") {
        await win.audioContext.resume();
      }
      win.currentAudioBuffer = await win.audioContext.decodeAudioData(
        Uint8Array.from(audioData).buffer,
      );
    }, Array.from(buffer));

    await page.waitForTimeout(300);

    const voiceBtn = composer.locator(SELECTORS.voiceNoteButton).first();
    if (!(await visible(voiceBtn, 3000))) {
      logger.warn("Voice note button not visible in composer", { chatId });
      return false;
    }
    try {
      await voiceBtn.click({ timeout: 3000, noWaitAfter: true });
    } catch {
      await voiceBtn.dispatchEvent("click").catch(() => null);
    }

    const stopRecordingBtn = composer
      .locator('div[role="button"][aria-label="Stop recording"]')
      .first();
    const recordingStarted = await visible(stopRecordingBtn, 4000);
    if (!recordingStarted) {
      logger.warn("Recording did not start after clicking voice button", {
        chatId,
      });
      return false;
    }

    const durationSec = await page.evaluate(async () => {
      const win = window as any;
      if (win.audioContext.state === "suspended") {
        await win.audioContext.resume();
      }
      const source = win.audioContext.createBufferSource();
      const gain = win.audioContext.createGain();
      gain.gain.value = 1;
      source.buffer = win.currentAudioBuffer;
      source.connect(gain);
      gain.connect(win.mixedDestination);
      source.start(0);
      return source.buffer.duration;
    });

    // Instagram voice messages require a minimum duration (at least 1.2s)
    const playWaitMs = Math.max(durationSec, 1.2) * 1000 + 400;
    await page.waitForTimeout(playWaitMs);

    const messageList = conversation.locator(SELECTORS.messageList).first();
    const beforeCount = await messageList
      .locator(SELECTORS.messageContainer)
      .count();

    const sendBtn = composer.locator(SELECTORS.sendVoiceNoteButton).first();
    if (!(await visible(sendBtn, 3000))) {
      logger.warn("Send voice note button not visible during recording", {
        chatId,
      });
      const closeBtn = composer
        .locator('div[role="button"][aria-label="Close Button"]')
        .first();
      if (await visible(closeBtn, 1000)) await click(closeBtn);
      return false;
    }

    try {
      await sendBtn.click({ timeout: 3000, noWaitAfter: true });
    } catch {
      await sendBtn.dispatchEvent("click").catch(() => null);
    }

    // Wait for the recording UI to close
    const recordingClosed = await stopRecordingBtn
      .waitFor({ state: "hidden", timeout: 4000 })
      .then(() => true)
      .catch(() => false);

    if (!recordingClosed) {
      logger.warn(
        "Recording toolbar did not close after click; dispatching click",
        { chatId },
      );
      await sendBtn.dispatchEvent("click").catch(() => null);
      await stopRecordingBtn
        .waitFor({ state: "hidden", timeout: 3000 })
        .catch(() => null);
    }

    const stillRecording = await stopRecordingBtn
      .isVisible()
      .catch(() => false);
    if (stillRecording) {
      logger.warn("Voice note send was rejected by Instagram; canceling", {
        chatId,
      });
      const closeBtn = composer
        .locator('div[role="button"][aria-label="Close Button"]')
        .first();
      if (await visible(closeBtn, 1000)) await click(closeBtn);
      return false;
    }

    await page.evaluate(() => {
      (window as any).currentAudioBuffer = null;
    });

    const verified = await waitForNewMessage(page, beforeCount, 10000);
    if (!verified) {
      logger.warn("Voice note sent but did not appear in conversation", {
        chatId,
      });
      return false;
    }

    logger.info("Voice note sent successfully", {
      chatId,
      reply: replyReady,
      durationSec,
    });
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