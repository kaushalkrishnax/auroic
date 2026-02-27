/**
 * Browser connection manager.
 * Multi-tab mode: one tab per chat, opened once on startup.
 */

import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import config from "../config/index.js";
import logger from "../utils/logger.js";
import { retry } from "../utils/retry.js";

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
const _chatPages = new Map<string, Page>();

export async function connectBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
}> {
  if (_browser?.isConnected()) {
    return { browser: _browser, context: _context! };
  }

  logger.info("Connecting to Chrome via CDP…", { url: config.cdp.url });

  const browser = await retry(() => chromium.connectOverCDP(config.cdp.url), {
    maxAttempts: config.retry.maxAttempts,
    baseDelayMs: config.retry.baseDelayMs,
    label: "CDP connection",
  });

  const contexts = browser.contexts();
  const context =
    contexts.length > 0 ? contexts[0] : await browser.newContext();

  browser.on("disconnected", () => {
    logger.warn("Browser disconnected — will reconnect on next poll cycle");
    _browser = null;
    _context = null;
    _chatPages.clear();
  });

  _browser = browser;
  _context = context;

  logger.info("Connected to browser successfully");
  return { browser, context };
}

export async function openChatTabs(
  chatIds: string[],
): Promise<Map<string, Page>> {
  const { context } = await connectBrowser();

  for (const chatId of chatIds) {
    if (_chatPages.has(chatId)) {
      const existing = _chatPages.get(chatId)!;
      if (!existing.isClosed()) continue;
      _chatPages.delete(chatId);
    }

    const chatUrl = `https://www.instagram.com/direct/t/${chatId}/`;
    logger.info("Opening tab for chat…", { chatId });

    const page = await context.newPage();
    await page.goto(chatUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    try {
      const notNow = page.locator('button:has-text("Not Now")');
      await notNow.click({ timeout: 3_000 });
      logger.debug("Dismissed notifications dialog", { chatId });
    } catch {
      // Dialog didn't appear — fine.
    }

    await page.waitForSelector('[role="textbox"][aria-label]', {
      timeout: 15_000,
    });
    logger.info("Chat tab ready", { chatId });

    _chatPages.set(chatId, page);
  }

  return _chatPages;
}

export function getChatPage(chatId: string): Page | undefined {
  return _chatPages.get(chatId);
}

export async function ensureChatTabs(chatIds: string[]): Promise<void> {
  const deadChats = chatIds.filter((id) => {
    const page = _chatPages.get(id);
    return !page || page.isClosed();
  });

  if (deadChats.length > 0) {
    logger.warn("Re-opening dead chat tabs", { chatIds: deadChats });
    await openChatTabs(deadChats);
  }
}

export async function disconnectBrowser(): Promise<void> {
  if (_browser?.isConnected()) {
    _browser = null;
    _context = null;
    _chatPages.clear();
    logger.info("Detached from browser");
  }
}
