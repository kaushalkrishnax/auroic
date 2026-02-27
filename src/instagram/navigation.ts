/**
 * Instagram navigation helpers.
 */

import type { Page } from "playwright-core";
import SELECTORS from "./selectors.js";
import logger from "../utils/logger.js";
import { randomDelay } from "../utils/delay.js";

export async function navigateToChat(
  page: Page,
  chatId: string,
): Promise<void> {
  const chatUrl = `https://www.instagram.com/direct/t/${chatId}/`;
  const current = page.url();

  if (current.includes(`/direct/t/${chatId}`)) {
    logger.debug("Already on target chat — DOM updates automatically", {
      chatId,
    });
    return;
  }

  logger.info("Navigating to chat…", { chatId });
  await page.goto(chatUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  try {
    const notNow = page.locator(SELECTORS.notNowButton);
    await notNow.click({ timeout: 3_000 });
    logger.debug("Dismissed notifications dialog");
  } catch {
    // Dialog didn't appear — fine.
  }

  await page.waitForSelector(SELECTORS.messageInput, { timeout: 15_000 });
  await randomDelay(1_000, 2_000);
  logger.info("Chat loaded", { chatId });
}
