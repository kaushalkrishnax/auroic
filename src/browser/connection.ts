/**
 * Browser connection manager.
 * Multi-tab mode: one tab per chat, opened once on startup.
 */

import fs from "fs";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import logger from "../utils/logger.js";
import getConfig from "../config/index.js";
import SELECTORS from "../instagram/selectors.js";

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
const _chatPages = new Map<string, Page>();

export async function connectBrowser(): Promise<{
  context: BrowserContext;
}> {
  if (_context) {
    return { context: _context };
  }

  const config = getConfig();
  const profileDir = config.chromium.profileDir;

  fs.mkdirSync(profileDir, { recursive: true });

  logger.info(`Launching Headless Chromium…`, {
    profileDir,
  });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,

    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=site-per-process,Translate,BackForwardCache",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--mute-audio",
      "--disable-default-apps",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-client-side-phishing-detection",
      "--process-per-site",
      "--single-process",
      "--renderer-process-limit=2",
      "--blink-settings=imagesEnabled=false",
      "--shm-size=512m",
    ],
  });

  context.on("close", () => {
    logger.warn("Browser context closed");
    _context = null;
  });

  _context = context;

  logger.info("Chromium launched successfully");

  return { context };
}

export async function openChatTabs(
  chatIds: string[],
): Promise<Map<string, Page>> {
  const { context } = await connectBrowser();

  if (chatIds.length === 0) return _chatPages;

  const firstChatId = chatIds[0];
  const firstChatUrl = `https://www.instagram.com/direct/t/${firstChatId}/`;

  logger.info("Opening first chat tab…", { chatId: firstChatId });

  const pages = context.pages();
  const firstPage = pages.length ? pages[0] : await context.newPage();

  await firstPage.goto(firstChatUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  if (firstPage.url().includes("/accounts/login")) {
    await performLogin(firstPage);
  }

  await firstPage.waitForSelector('div[contenteditable="true"]', {
    timeout: 30_000,
  });

  logger.info("First chat ready", { chatId: firstChatId });
  _chatPages.set(firstChatId, firstPage);

  for (const chatId of chatIds.slice(1)) {
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
      timeout: 60_000,
    });

    const notNowButton = page.locator(SELECTORS.notNowButton);
    if (await notNowButton.count()) {
      await notNowButton.click();
      logger.info("Not now clicked");
    }

    await page.waitForSelector('div[contenteditable="true"]', {
      timeout: 30_000,
    });

    logger.info("Chat tab ready", { chatId });
    _chatPages.set(chatId, page);
  }

  return _chatPages;
}

async function performLogin(page: Page): Promise<void> {
  const config = getConfig();
  logger.info("Logging in…");

  await page.waitForSelector(SELECTORS.emailInput, {
    timeout: 15_000,
  });

  await page.fill(SELECTORS.emailInput, config.instagram.username);
  await page.fill(SELECTORS.passwordInput, config.instagram.password);

  (await page.click(SELECTORS.submitButton), logger.info("Login submitted"));

  await page.waitForURL(/instagram\.com\/accounts\/onetap/);

  // Handle save info popup
  try {
    const saveInfo = page.locator(SELECTORS.saveInfoButton);
    if (await saveInfo.count()) {
      await saveInfo.click();
    }
  } catch {}

  logger.info("Login successful");
}

export function getChatPage(chatId: string): Page | undefined {
  return _chatPages.get(chatId);
}

export async function ensureChatTabs(chatIds: string[]): Promise<void> {
  const { context } = await connectBrowser();

  // Close and remove chats that are no longer in chatIds
  const toRemove = Array.from(_chatPages.keys()).filter(
    (id) => !chatIds.includes(id),
  );
  for (const id of toRemove) {
    const page = _chatPages.get(id);
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
    _chatPages.delete(id);
    logger.info("Closed chat tab for removed chatId", { chatId: id });
  }

  // Also close any stray/untracked tabs in the browser context
  const trackedPages = Array.from(_chatPages.values());
  for (const page of context.pages()) {
    if (!trackedPages.includes(page) && !page.isClosed()) {
      await page.close().catch(() => {});
      logger.info("Closed stray/untracked browser tab");
    }
  }

  // Open or re-open missed chats
  const deadChats = chatIds.filter((id) => {
    const page = _chatPages.get(id);
    return !page || page.isClosed();
  });

  if (deadChats.length > 0) {
    logger.warn("Opening dead/new chat tabs", { chatIds: deadChats });

    for (const chatId of deadChats) {
      if (_chatPages.has(chatId)) {
        _chatPages.delete(chatId);
      }

      const chatUrl = `https://www.instagram.com/direct/t/${chatId}/`;
      logger.info("Opening tab for chat…", { chatId });

      const page = await context.newPage();

      await page.goto(chatUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      const notNowButton = page.locator(SELECTORS.notNowButton);
      if (await notNowButton.count()) {
        await notNowButton.click();
        logger.info("Not now clicked");
      }

      await page.waitForSelector('div[contenteditable="true"]', {
        timeout: 30_000,
      });

      logger.info("Chat tab ready", { chatId });
      _chatPages.set(chatId, page);
    }
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
