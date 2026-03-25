/**
 * Browser session manager.
 * Single Playwright persistent context, single page for the active chat.
 */

import fs from "fs";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import logger from "@/utils/logger.js";
import getConfig from "@/runtime/index.js";
import { attachDataMidsForRecentWindow } from "@/automation/chat.js";
import { getStartupConversationIds } from "@/db/queries/conversations.js";
import SELECTORS from "@/instagram/selectors.js";
import {
  initMailbox,
  initThread,
  parseWebsocketFrame,
} from "@/instagram/parsers.js";

let _context: BrowserContext | null = null;
let _sessionPage: Page | null = null;
let _sessionInitialized = false;
let _dialogPollInterval: ReturnType<typeof setInterval> | null = null;
let _mailboxInitialized = false;
let _mailboxInitPromise: Promise<void> = Promise.resolve();
let _resolveMailboxInit: (() => void) | null = null;

function clearDialogPolling(): void {
  if (!_dialogPollInterval) return;
  clearInterval(_dialogPollInterval);
  _dialogPollInterval = null;
}

function startDialogPolling(page: Page): void {
  clearDialogPolling();
  _dialogPollInterval = setInterval(() => {
    handleDialogs(page).catch((err) => {
      logger.debug("Dialog polling step failed", {
        error: err instanceof Error ? err.message : err,
      });
    });
  }, 2000);
}

function extractChatIdFromUrl(url: string): string | null {
  const match = url.match(/\/direct\/t\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function resetMailboxInitState(): void {
  _mailboxInitialized = false;
  _mailboxInitPromise = new Promise<void>((resolve) => {
    _resolveMailboxInit = resolve;
  });
}

function markMailboxInitialized(): void {
  if (_mailboxInitialized) return;
  _mailboxInitialized = true;
  if (_resolveMailboxInit) {
    _resolveMailboxInit();
    _resolveMailboxInit = null;
  }
}

async function waitForMailboxInitialization(timeoutMs = 45000): Promise<void> {
  if (_mailboxInitialized) return;

  await Promise.race([
    _mailboxInitPromise,
    new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Mailbox metadata initialization timed out"));
      }, timeoutMs);
    }),
  ]);
}

function getStartupCandidates(configuredChatIds: string[]): string[] {
  return getStartupConversationIds(configuredChatIds);
}

async function openChatById(page: Page, chatId: string): Promise<boolean> {
  await page.goto(`https://www.instagram.com/direct/t/${chatId}/`, {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });

  await page.waitForURL(new RegExp(`/direct/t/${chatId}(?:[/?#]|$)`), {
    timeout: 8000,
  });

  await page.waitForSelector(SELECTORS.messageInput, { timeout: 8000 });
  return true;
}

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
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--no-first-run",
      "--disable-default-apps",
      "--disable-component-update",
      "--blink-settings=imagesEnabled=false",
      "--use-fake-ui-for-media-stream",
      "--allow-file-access-from-files",
      "--disable-extensions",
      "--mute-audio",
    ],
    permissions: ["microphone"],
  });

  context.on("close", () => {
    logger.warn("Browser context closed");
    clearDialogPolling();
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
    clearDialogPolling();
    _sessionPage = null;
    _sessionInitialized = false;
  });

  page.on("close", () => {
    logger.warn("Page closed — resetting session");
    clearDialogPolling();
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
        markMailboxInitialized();
        return;
      }

      if (postData.includes("IGDThreadDetailMainViewContainerQuery")) {
        const data = await response.json();
        const chatId = initThread(data);
        if (chatId) {
          await attachDataMidsForRecentWindow(chatId, 8);
        }
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

export async function handleDialogs(page: Page): Promise<void> {
  const buttons = [
    { name: "continue", selector: SELECTORS.continueButton },
    { name: "save info", selector: SELECTORS.saveInfoButton },
    { name: "not now", selector: SELECTORS.notNowButton },
  ];

  for (const btn of buttons) {
    const locator = page.locator(btn.selector).first();

    if (await locator.isVisible().catch(() => false)) {
      try {
        await locator.click({ timeout: 1000 });
        logger.info(`Closed dialog: ${btn.name}`);
        return;
      } catch (err) {
        logger.warn(`Failed to click dialog button: ${btn.name}`);
      }
    }
  }
}

/* ------------------------------------------------ */
/* Session init                                      */
/* ------------------------------------------------ */

export async function initInstagramSession(): Promise<void> {
  if (_sessionInitialized && _sessionPage && !_sessionPage.isClosed()) return;

  const { context } = await connectBrowser();

  const config = getConfig();
  const chatUrl = "https://www.instagram.com/direct/inbox/";

  logger.info("Opening Instagram session…", {
    configuredChatId: config.instagram.chatIds[0] ?? null,
    startupMode: "db-first-most-recent",
  });

  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();

  resetMailboxInitState();

  /* Attach listeners BEFORE navigation */
  attachPageListeners(page);

  await page.goto(chatUrl);

  if (page.url().includes("/accounts/login")) {
    await performLogin(page);
    await page
      .waitForURL(/\/direct\/(?:inbox|t\/[^/?#]+)(?:[/?#]|$)/, {
        timeout: 20000,
      })
      .catch(() => undefined);
  }

  if (!page.url().includes("/direct/")) {
    await page.goto("https://www.instagram.com/direct/inbox/", {
      waitUntil: "domcontentloaded"
    });
  }

  await page
    .waitForURL(/\/direct\/(?:inbox|t\/[^/?#]+)(?:[/?#]|$)/)
    .catch(() => undefined);

  startDialogPolling(page);

  let startupCandidates = getStartupCandidates(config.instagram.chatIds);
  let startupChatId: string | null = null;

  if (!startupChatId && startupCandidates.length === 0) {
    await page.goto(chatUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await waitForMailboxInitialization();
    startupCandidates = getStartupCandidates(config.instagram.chatIds);
  }

  if (!startupChatId && startupCandidates.length > 0) {
    const primaryChatId = startupCandidates[0];
    await openChatById(page, primaryChatId);
    startupChatId = primaryChatId;
  }

  if (!startupChatId) {
    throw new Error("No startup chat available after mailbox initialization");
  }

  logger.info("Instagram session ready", {
    startupChatId,
    configuredChatId: config.instagram.chatIds[0] ?? null,
  });

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
  clearDialogPolling();

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
