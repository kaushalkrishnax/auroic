/**
 * Instagram navigation helpers.
 */

import { getPage } from "@/automation/session.js";
import SELECTORS from "@/instagram/selectors.js";
import logger from "@/utils/logger.js";
import { getConversationById } from "@/db/queries/conversations.js";

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTitleRegex(title: string): RegExp {
  const normalized = normalizeTitle(title);
  if (!normalized) throw new Error("Cannot build title regex from empty title");
  const tokens = normalized.split(" ").filter(Boolean);
  const pattern = tokens.map((token) => escapeRegExp(token)).join(".*");
  return new RegExp(pattern, "i");
}

async function ensureThreadListVisible(): Promise<void> {
  const page = getPage();
  const threadList = page
    .locator(`${SELECTORS.threadList}, nav[role=\"navigation\"], [aria-label*=\"Thread\"]`)
    .first();

  if (await threadList.isVisible().catch(() => false)) return;

  await page.goto("https://www.instagram.com/direct/inbox/", {
    waitUntil: "domcontentloaded",
    timeout: 10000,
  });

  await threadList.waitFor({ state: "visible", timeout: 8000 });
}

async function clickChatFromThreadListByTitle(
  chatId: string,
  title: string,
): Promise<void> {
  await ensureThreadListVisible();

  const page = getPage();
  const threadList = page
    .locator(`${SELECTORS.threadList}, nav[role=\"navigation\"], [aria-label*=\"Thread\"]`)
    .first();
  const links = threadList.locator('a[href*="/direct/t/"]');
  const titleRegex = buildTitleRegex(title);
  const targetUrlPattern = new RegExp(`/direct/t/${chatId}(?:[/?#]|$)`);

  const count = await links.count();
  if (count === 0) {
    throw new Error("No thread links available in inbox thread list");
  }

  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const rawText = (await link.innerText().catch(() => "")) || "";
    const normalizedCandidate = normalizeTitle(rawText);

    if (!normalizedCandidate || !titleRegex.test(normalizedCandidate)) {
      continue;
    }

    await link.click({ timeout: 3500 });
    await page.waitForURL(targetUrlPattern, { timeout: 6000 });
    return;
  }

  throw new Error(`Chat not found in thread list by title regex: ${title}`);
}

async function navigateViaGoto(chatId: string): Promise<void> {
  const page = getPage();
  const targetUrl = `https://www.instagram.com/direct/t/${chatId}/`;
  const targetUrlPattern = new RegExp(`/direct/t/${chatId}(?:[/?#]|$)`);
  const input = page.locator(SELECTORS.messageInput).first();

  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 10000,
  });
  await page.waitForURL(targetUrlPattern, { timeout: 8000 });
  await input.waitFor({ state: "visible", timeout: 8000 });
}

export async function navigateToChat(chatId: string): Promise<void> {
  const page = getPage();
  const current = page.url();
  const input = page.locator(SELECTORS.messageInput).first();

  if (current.includes(`/direct/t/${chatId}`) && (await input.isVisible().catch(() => false))) {
    logger.info("Already on target chat", { chatId });
    return;
  }

  logger.info("Navigating to chat…", { chatId });

  const chat = await getConversationById(chatId);
  const chatTitle = chat?.title || "";

  try {
    if (!chatTitle) {
      throw new Error("Missing conversation title for click navigation");
    }

    await clickChatFromThreadListByTitle(chatId, chatTitle);
    await input.waitFor({ state: "visible", timeout: 8000 });
    logger.info("Chat loaded via thread list click", { chatId, title: chatTitle });
    return;
  } catch (clickErr) {
    try {
      await navigateViaGoto(chatId);
      logger.warn("Chat loaded via page.goto fallback", {
        chatId,
        title: chatTitle || null,
        clickError: (clickErr as Error).message,
      });
      return;
    } catch (gotoErr) {
      logger.error("Failed to navigate to chat", {
        chatId,
        title: chatTitle || null,
        clickError: (clickErr as Error).message,
        gotoError: (gotoErr as Error).message,
      });
      throw gotoErr;
    }
  }
}
