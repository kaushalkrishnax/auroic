/**
 * Instagram chat interaction helpers.
 *
 * Scrape the last message using DOM selectors,
 * detect triggers, and send replies.
 */

import type { Page } from "playwright-core";
import SELECTORS from "./selectors.js";
import config from "../config/index.js";
import logger from "../utils/logger.js";
import { randomDelay } from "../utils/delay.js";

export interface LastMessageData {
  text: string;
  count: number;
  history: string[];
  lastSender: string;
}

export async function getChatUsername(
  page: Page,
  myUsername: string,
): Promise<string> {
  try {
    const username = await page.evaluate((myUser: string) => {
      const avatars = document.querySelectorAll(
        '.x1i10hfl.x1qjc9v5[href^="/"]',
      );
      for (const avatar of avatars) {
        const href = avatar.getAttribute("href");
        const match = href?.match(/^\/([^/]+)\/?/);
        if (match && match[1] !== myUser) {
          return match[1];
        }
      }
      return "unknown";
    }, myUsername);
    return username;
  } catch {
    return "unknown";
  }
}

export async function getLastMessageData(
  page: Page,
  myUsername: string,
): Promise<LastMessageData | null> {
  try {
    const data = await page.evaluate(
      (args: {
        sel: { messageGroup: string; messageText: string };
        myUsername: string;
      }) => {
        const messageGroups = document.querySelectorAll(args.sel.messageGroup);
        if (!messageGroups.length) return null;

        let totalCount = 0;
        const allTextNodes: string[] = [];
        const userMessages: string[] = [];
        let finalSenderInDom = "unknown";

        for (const group of messageGroups) {
          const nodes = group.querySelectorAll(args.sel.messageText);
          if (nodes.length > 0) {
            totalCount += nodes.length;

            const avatarLink = group.querySelector(
              '.x1i10hfl.x1qjc9v5[href^="/"]',
            );
            let sender = args.myUsername;
            if (avatarLink) {
              const href = avatarLink.getAttribute("href");
              const match = href?.match(/^\/([^/]+)\/?/);
              if (match) sender = match[1];
            }

            finalSenderInDom = sender;

            for (const node of nodes) {
              const text = (node as HTMLElement).innerText.trim();
              allTextNodes.push(text);

              if (sender !== args.myUsername) {
                userMessages.push(text);
              }
            }
          }
        }

        if (allTextNodes.length === 0) return null;

        const lastText = allTextNodes[allTextNodes.length - 1];
        const recentUserMsgs = userMessages.slice(-20).slice(-10);

        const history = recentUserMsgs.map((text, index) => {
          if (index === recentUserMsgs.length - 1 && text === lastText)
            return text;
          const words = text.split(" ");
          if (words.length > 50) return words.slice(0, 50).join(" ") + "...";
          return text;
        });

        return {
          text: lastText,
          count: totalCount,
          history,
          lastSender: finalSenderInDom,
        };
      },
      {
        sel: {
          messageGroup: SELECTORS.messageGroup,
          messageText: SELECTORS.messageText,
        },
        myUsername,
      },
    );

    return data;
  } catch (err) {
    logger.warn("Failed to extract last message data", {
      error: (err as Error).message,
    });
    return null;
  }
}

export async function isLastMessageReply(page: Page): Promise<boolean> {
  try {
    const isReply = await page.evaluate(
      (sel: { messageGroup: string; replyQuote: string }) => {
        const messageGroups = document.querySelectorAll(sel.messageGroup);
        if (!messageGroups.length) return false;

        const lastGroup = messageGroups[messageGroups.length - 1];
        if (!lastGroup) return false;

        return lastGroup.querySelector(sel.replyQuote) !== null;
      },
      {
        messageGroup: SELECTORS.messageGroup,
        replyQuote: SELECTORS.replyQuote,
      },
    );

    return isReply;
  } catch (err) {
    logger.warn("Reply detection failed", { error: (err as Error).message });
    return false;
  }
}

export function shouldTrigger(messageText: string, isReply: boolean): boolean {
  const lower = messageText.toLowerCase();

  for (const mention of config.triggers.mentions) {
    if (lower.includes(mention)) return true;
  }

  for (const hashtag of config.triggers.hashtags) {
    if (lower.includes(hashtag)) return true;
  }

  for (const keyword of config.triggers.keywords) {
    if (lower.includes(keyword)) return true;
  }

  if (config.triggers.onReply && isReply) return true;

  return false;
}

export function messageFingerprint(
  conversationId: string,
  senderUsername: string,
  messageText: string,
  messageCount: number,
): string {
  const snippet = messageText.substring(0, 100);
  return `${conversationId}::${senderUsername}::${messageCount}::${snippet}`;
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.locator(SELECTORS.messageInput).first();
  await input.click({ timeout: 5_000 });
  await randomDelay(200, 400);

  await input.fill("");
  await input.pressSequentially(text, { delay: 15 });

  await randomDelay(300, 600);

  await input.press("Enter");
  logger.info("Reply sent", { length: text.length });

  await randomDelay(500, 1_000);
}
