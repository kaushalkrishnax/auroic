/**
 * Browser session manager.
 * Single Playwright persistent context, single page for the active chat.
 */

import fs from "fs";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import logger from "@/utils/logger.js";
import getConfig from "@/runtime/index.js";
import SELECTORS from "@/instagram/selectors.js";
import {
  initMailbox,
  initThread,
  parseWebsocketFrame,
} from "@/instagram/parsers.js";

let _context: BrowserContext | null = null;
let _sessionPage: Page | null = null;
let _sessionInitialized = false;

/* ------------------------------------------------ */
/* Browser connect                                   */
/* ------------------------------------------------ */

export async function connectBrowser(): Promise<{ context: BrowserContext }> {
  if (_context) return { context: _context };

  const config = getConfig();
  const profileDir = config.chromium.profileDir;

  fs.mkdirSync(profileDir, { recursive: true });

  logger.info("Launching headless Chromium…", { profileDir });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--no-first-run",
      "--mute-audio",
      "--disable-default-apps",
      "--disable-component-update",
      "--blink-settings=imagesEnabled=false",
    ],
  });

  context.on("close", () => {
    logger.warn("Browser context closed");
    _sessionPage = null;
    _sessionInitialized = false;
    _context = null;
  });

  _context = context;

  logger.info("Chromium launched");

  return { context };
}

/* ------------------------------------------------ */
/* Page listeners                                    */
/* ------------------------------------------------ */

function attachPageListeners(page: Page): void {
  page.removeAllListeners();

  page.on("crash", () => {
    logger.error("Page crashed — resetting session");
    _sessionPage = null;
    _sessionInitialized = false;
  });

  page.on("close", () => {
    logger.warn("Page closed — resetting session");
    _sessionPage = null;
    _sessionInitialized = false;
  });

  /* GraphQL interceptor */

  page.on("response", async (response) => {
    try {
      if (
        !response.url().includes("/api/graphql") ||
        response.status() !== 200 ||
        response.request().method() !== "POST"
      )
        return;

      const postData = response.request().postData();
      if (!postData) return;

      if (postData.includes("PolarisDirectInboxQuery")) {
        const data = await response.json();
        initMailbox(data);
        return;
      }

      if (postData.includes("IGDThreadDetailMainViewContainerQuery")) {
        const data = await response.json();
        initThread(data);
        return;
      }
    } catch (err) {
      logger.warn("Failed to parse GraphQL response", {
        error: err instanceof Error ? err.message : err,
      });
    }
  });

  /* WebSocket interceptor */

  page.on("websocket", (ws) => {
    ws.on("framereceived", async (frame) => {
      try {
        const payload = frame.payload.toString("utf8");

        if (!payload.includes("/ig_message_sync")) return;

        const cfg = getConfig();

        parseWebsocketFrame(payload, cfg.instagram.chatIds);
      } catch (err) {
        logger.error("WebSocket frame processing failed", {
          error: err instanceof Error ? err.message : err,
        });
      }
    });
  });
}

/* ------------------------------------------------ */
/* Session helpers                                   */
/* ------------------------------------------------ */

export function getPage(): Page {
  if (!_sessionPage || _sessionPage.isClosed()) {
    throw new Error(
      "No active browser session — call initInstagramSession() first",
    );
  }

  return _sessionPage;
}

export async function ensureSession(): Promise<Page> {
  if (!_sessionPage || _sessionPage.isClosed()) {
    await initInstagramSession();
  }

  return _sessionPage!;
}

/* ------------------------------------------------ */
/* Session init                                      */
/* ------------------------------------------------ */

export async function initInstagramSession(): Promise<void> {
  if (_sessionInitialized && _sessionPage && !_sessionPage.isClosed()) return;

  const { context } = await connectBrowser();

  const config = getConfig();
  const chatId = config.instagram.chatIds[0];
  const chatUrl = `https://www.instagram.com/direct/t/${chatId}/`;

  logger.info("Opening Instagram session…", { chatId });

  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();

  /* Attach listeners BEFORE navigation */
  attachPageListeners(page);

  await page.goto(chatUrl);

  if (page.url().includes("/accounts/login")) {
    await performLogin(page);
  }

  /* Handle possible dialogs */

  const dialogTimeout = 5000;
  const start = Date.now();

  while (Date.now() - start < dialogTimeout) {
    if (await page.locator(SELECTORS.continueButton).count()) {
      await page.click(SELECTORS.continueButton);
      logger.info("Clicked continue button");
      continue;
    }

    if (await page.locator(SELECTORS.saveInfoButton).count()) {
      await page.click(SELECTORS.saveInfoButton);
      logger.info("Clicked save info button");
      continue;
    }

    if (await page.locator(SELECTORS.notNowButton).count()) {
      await page.click(SELECTORS.notNowButton);
      logger.info("Clicked not now button");
      continue;
    }

    await page.waitForTimeout(300);
  }

  await page
    .waitForSelector('div[contenteditable="true"]', { timeout: 10000 })
    .catch(() => {
      logger.warn("Message input not visible after 10s — continuing anyway", {
        chatId,
      });
    });

  logger.info("Instagram session ready", { chatId });

  _sessionPage = page;
  _sessionInitialized = true;
}

/* ------------------------------------------------ */
/* Login                                             */
/* ------------------------------------------------ */

async function performLogin(page: Page): Promise<void> {
  const config = getConfig();

  logger.info("Logging in to Instagram…");

  await page.waitForSelector(SELECTORS.emailInput);

  await page.fill(SELECTORS.emailInput, config.instagram.username);
  await page.fill(SELECTORS.passwordInput, config.instagram.password);

  await page.click(SELECTORS.submitButton);

  logger.info("Login submitted");
}

/* ------------------------------------------------ */
/* Disconnect                                        */
/* ------------------------------------------------ */

export async function disconnectBrowser(): Promise<void> {
  if (_context) {
    try {
      await _context.close();
    } catch (err) {
      logger.warn("Failed to close browser context", {
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  _sessionPage = null;
  _sessionInitialized = false;
  _context = null;

  logger.info("Browser disconnected");
}
