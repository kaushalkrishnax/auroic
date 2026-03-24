/**
 * Instagram navigation helpers.
 */

import { getPage } from "@/automation/session.js";
import SELECTORS from "@/instagram/selectors.js";
import logger from "@/utils/logger.js";
import { getConversationById } from "@/db/queries/conversations.js";

export async function navigateToChat(chatId: string): Promise<void> {
  const page = getPage();
  const current = page.url();

  if (current.includes(`/direct/t/${chatId}`)) {
    logger.info("Already on target chat", { chatId });
    return;
  }

  logger.info("Navigating to chat…", { chatId });

  const chat = await getConversationById(chatId);
  const chatTitle = chat?.title || "unknown";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await openChatByTitle(chatTitle);

      await page.waitForURL(new RegExp(`/direct/t/${chatId}(?:[/?#]|$)`), {
        timeout: 4000,
      });

      const input = page.locator(SELECTORS.messageInput).first();
      if (!(await input.isVisible({ timeout: 2000 }))) {
        throw new Error("Message input not visible");
      }

      logger.info("Chat loaded", { chatId });
      return;
    } catch (err) {
      if (attempt === 3) {
        try {
          await page.goto(`https://www.instagram.com/direct/t/${chatId}/`, {
            waitUntil: "domcontentloaded",
            timeout: 4000,
          });

          await page.waitForURL(new RegExp(`/direct/t/${chatId}(?:[/?#]|$)`), {
            timeout: 3000,
          });

          const input = page.locator(SELECTORS.messageInput).first();
          if (!(await input.isVisible({ timeout: 2000 }))) {
            throw new Error("Message input not visible after URL fallback");
          }

          logger.warn("Chat loaded via URL fallback", {
            chatId,
            title: chatTitle,
            attempt,
          });
          return;
        } catch (fallbackErr) {
          logger.error("Failed to navigate to chat after retries", {
            chatId,
            title: chatTitle,
            attempt,
            error: (fallbackErr as Error).message,
            rootError: (err as Error).message,
          });
          throw fallbackErr;
        }
      }

      await page.waitForTimeout(50 * attempt);
    }
  }
}

export async function openChatByTitle(title: string): Promise<void> {
  const page = getPage();
  const threadList = page.locator(SELECTORS.threadList).first();
  await threadList.waitFor({ state: "visible", timeout: 3000 });

  const normalize = (value: string): string =>
    value.replace(/\s+/g, " ").trim().toLowerCase();

  const normalizedTitle = normalize(title);
  const clickable = threadList.locator(
    'button, a[href*="/direct/t/"], [role="button"], [role="link"]',
  );

  const direct = clickable.filter({ hasText: title }).first();
  if ((await direct.count()) > 0) {
    await direct.click({ timeout: 3500 });
    return;
  }

  const count = await clickable.count();
  for (let i = 0; i < count; i++) {
    const candidate = clickable.nth(i);
    const rawText = (await candidate.innerText().catch(() => "")) || "";
    const normalizedCandidate = normalize(rawText);

    if (
      normalizedCandidate === normalizedTitle ||
      normalizedCandidate.includes(normalizedTitle) ||
      normalizedTitle.includes(normalizedCandidate)
    ) {
      await candidate.click({ timeout: 3500 });
      return;
    }
  }

  throw new Error(`Chat not found in sidebar: ${title}`);
}
