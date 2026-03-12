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

  await openChatByTitle(chatTitle);

  await page
    .waitForSelector(SELECTORS.messageInput, { state: "visible" })
    .catch(() => {
      logger.warn("Message input not found after navigation", { chatId });
    });
  logger.info("Chat loaded", { chatId });
}

export async function openChatByTitle(title: string): Promise<void> {
  const page = getPage();
  const threadList = page.locator(SELECTORS.threadList).first();
  const chatNodes = threadList.locator("span").filter({ hasText: title });

  if ((await chatNodes.count()) === 0) {
    throw new Error(`Chat not found in sidebar: ${title}`);
  }

  await chatNodes.first().click();
}
