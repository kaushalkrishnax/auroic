import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page, WebSocket } from "playwright-core";
import getConfig from "@/runtime/index.js";
import { attachDataMidsForRecentWindow } from "@/automation/chat.js";
import {
  ensureChatPage,
  initTabPool,
  isTabPoolInitialized,
  resetTabPool,
} from "@/automation/tabPool.js";
import { getStartupConversationIds } from "@/db/queries/conversations.js";
import SELECTORS from "@/instagram/selectors.js";
import {
  initMailbox,
  initThread,
  parseWebsocketFrame,
} from "@/instagram/parsers.js";
import logger from "@/utils/logger.js";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let polling: NodeJS.Timeout | null = null;
let dialogPollMisses = 0;
let browserConnectPromise: Promise<{ browser: Browser; context: BrowserContext; page: Page }> | null = null;
const CHROMIUM_CDP_URL =
  process.env.CHROMIUM_CDP_URL ?? "http://127.0.0.1:9222";

const DIALOG_POLL_FAST_MS = 2_000;
const DIALOG_POLL_SLOW_MS = 8_000;
const DIALOG_POLL_BACKOFF_MISSES = 4;
const MAILBOX_TIMEOUT_MS = 45_000;
const OTP_TIMEOUT_MS = 5 * 60_000;

let pendingOtpResolver: ((code: string) => void) | null = null;
let pendingOtpRequestedAt: number | null = null;

let mailboxReady = false;
let mailboxResolve: (() => void) | null = null;
let mailboxPromise = new Promise<void>((resolve) => {
  mailboxResolve = resolve;
});

const resetMailbox = () => {
  mailboxReady = false;
  mailboxPromise = new Promise<void>((resolve) => {
    mailboxResolve = resolve;
  });
};

const markMailbox = () => {
  if (mailboxReady) return;
  mailboxReady = true;
  mailboxResolve?.();
  mailboxResolve = null;
};

const waitMailbox = (timeoutMs = MAILBOX_TIMEOUT_MS) => {
  if (mailboxReady) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Mailbox did not load within ${timeoutMs}ms`));
    }, timeoutMs);

    mailboxPromise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
};

const stopPolling = () => {
  if (polling) clearTimeout(polling);
  polling = null;
  dialogPollMisses = 0;
};

const startPolling = (p: Page) => {
  stopPolling();
  dialogPollMisses = 0;

  const tick = async () => {
    try {
      const handled = await handleDialogs(p);
      dialogPollMisses = handled ? 0 : dialogPollMisses + 1;
    } catch (error) {
      dialogPollMisses += 1;
      logger.debug("Instagram dialog polling failed", {
        error: String(error),
      });
    }

    if (!page || page !== p || p.isClosed()) {
      stopPolling();
      return;
    }

    const nextDelay =
      dialogPollMisses >= DIALOG_POLL_BACKOFF_MISSES
        ? DIALOG_POLL_SLOW_MS
        : DIALOG_POLL_FAST_MS;

    polling = setTimeout(() => {
      void tick();
    }, nextDelay);
  };

  void tick();
};

export const isOtpPending = () => pendingOtpResolver !== null;

export const getOtpPendingRequestedAt = () => pendingOtpRequestedAt;

export const submitOtpCode = (rawCode: string) => {
  if (!pendingOtpResolver) return false;

  const code = rawCode.trim();
  if (!code) return false;

  const resolve = pendingOtpResolver;
  pendingOtpResolver = null;
  pendingOtpRequestedAt = null;
  resolve(code);
  return true;
};

const waitForOtpCode = (timeoutMs = OTP_TIMEOUT_MS) =>
  new Promise<string>((resolve, reject) => {
    if (pendingOtpResolver) {
      reject(new Error("OTP already pending"));
      return;
    }

    pendingOtpRequestedAt = Date.now();

    const timer = setTimeout(() => {
      if (pendingOtpResolver === onResolve) {
        pendingOtpResolver = null;
        pendingOtpRequestedAt = null;
      }
      reject(new Error("OTP timeout"));
    }, timeoutMs);

    const onResolve = (code: string) => {
      clearTimeout(timer);
      resolve(code);
    };

    pendingOtpResolver = onResolve;
  });

const isPageUsable = (candidate: Page | null): candidate is Page =>
  Boolean(candidate && !candidate.isClosed());

/**
 * Connect to native Termux Chromium through its remote debugging endpoint.
 * Reuse Chromium's default context so its persistent profile and cookies remain available.
 */
export async function connectBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  if (browser && context && isPageUsable(page)) {
    return { browser, context, page };
  }

  if (browserConnectPromise) return browserConnectPromise;

  browserConnectPromise = (async () => {
    let connectedBrowser: Browser | null = null;

    try {
      connectedBrowser = await chromium.connectOverCDP(CHROMIUM_CDP_URL, {
        timeout: 30_000,
      });

      const contexts = connectedBrowser.contexts();
      const existingContext = contexts[0];

      if (!existingContext) {
        throw new Error(
          "Chromium CDP connected, but no default browser context was exposed. Start Chromium with --remote-debugging-port=9222 and a user-data-dir.",
        );
      }

      const pages = existingContext.pages();
      const existingPage =
        pages.find((candidate) => candidate.url().includes("instagram.com")) ??
        pages.find((candidate) => candidate.url() === "about:blank") ??
        (await existingContext.newPage());

      browser = connectedBrowser;
      context = existingContext;
      page = existingPage;

      existingContext.on("close", () => {
        if (context !== existingContext) return;
        stopPolling();
        resetTabPool();
        page = null;
        context = null;
      });

      existingPage.on("close", () => {
        if (page !== existingPage) return;
        stopPolling();
        page = null;
      });

      connectedBrowser.on("disconnected", () => {
        if (browser !== connectedBrowser) return;
        stopPolling();
        resetTabPool();
        page = null;
        context = null;
        browser = null;
      });

      logger.info("Connected to native Chromium", {
        browserVersion: connectedBrowser.version(),
        contextCount: contexts.length,
        pageCount: pages.length,
        currentUrl: existingPage.url(),
      });

      return {
        browser: connectedBrowser,
        context: existingContext,
        page: existingPage,
      };
    } catch (error) {
      if (connectedBrowser) {
        await connectedBrowser.close().catch(() => undefined);
      }
      throw error;
    }
  })();

  try {
    return await browserConnectPromise;
  } finally {
    browserConnectPromise = null;
  }
}

const frameToText = (payload: string | Buffer): string =>
  typeof payload === "string"
    ? payload
    : Buffer.from(payload).toString("utf8");

const attachWebSocketListeners = (ws: WebSocket) => {
  logger.info("Instagram WebSocket connected", { url: ws.url() });

  ws.on("framereceived", (frame) => {
    try {
      const rawFrame = frameToText(frame.payload);

      const jsonStart = rawFrame.indexOf("{");
      if (jsonStart < 0) {
        return;
      }

      const envelope = JSON.parse(rawFrame.slice(jsonStart)) as {
        payload?: string;
      };

      if (typeof envelope.payload !== "string" || !envelope.payload) {
        return;
      }

      const decoded = Buffer.from(envelope.payload, "base64").toString("utf8");

      parseWebsocketFrame(decoded, getConfig().instagram.chatIds);
    } catch (error) {
      logger.error("Instagram WebSocket frame processing failed", {
        url: ws.url(),
        error: String(error),
      });
    }
  });

  ws.on("socketerror", (error) => {
    logger.error("Instagram WebSocket error", {
      url: ws.url(),
      error: String(error),
    });
  });
};

const attachPageResponses = (p: Page) => {
  p.on("response", async (response) => {
    try {
      const url = response.url();
      const request = response.request();

      if (!url.includes("instagram.com")) return;

      if (
        !url.includes("/api/graphql") ||
        response.status() !== 200 ||
        request.method() !== "POST"
      ) {
        return;
      }

      const body = request.postData();
      if (!body) return;

      if (body.includes("PolarisDirectInboxQuery")) {
        const data = await response.json();
        initMailbox(data);
        markMailbox();
        logger.info("Instagram inbox response processed");
        return;
      }

      if (body.includes("IGDThreadDetailMainViewContainerQuery")) {
        const data = await response.json();
        const chatId = initThread(data);
        if (chatId) {
          await attachDataMidsForRecentWindow(chatId, 8);
        }
        logger.info("Instagram thread response processed", {
          chatId: chatId ?? null,
        });
      }
    } catch (error) {
      logger.error("Instagram response processing failed", {
        error: String(error),
      });
    }
  });
};

const attach = (p: Page) => {
  p.on("close", () => {
    if (page !== p) return;
    stopPolling();
    page = null;
  });

  p.on("crash", () => {
    if (page !== p) return;
    stopPolling();
    page = null;
    logger.error("Instagram page crashed");
  });

  attachPageResponses(p);

  p.on("websocket", attachWebSocketListeners);
};

export const handleDialogs = async (p: Page): Promise<boolean> => {
  const currentUrl = p.url();
  if (
    !currentUrl.includes("instagram.com") ||
    (!currentUrl.includes("/accounts/") && !currentUrl.includes("/direct/"))
  ) {
    return false;
  }

  for (const selector of [
    SELECTORS.continueButton,
    SELECTORS.saveInfoButton,
    SELECTORS.notNowButton,
  ]) {
    const element = p.locator(selector).first();
    if (await element.isVisible().catch(() => false)) {
      await element.click().catch((error) => {
        logger.debug("Could not dismiss Instagram dialog", {
          selector,
          error: String(error),
        });
      });
      return true;
    }
  }

  return false;
};

const navigateToInbox = async (p: Page) => {
  await p.goto("https://www.instagram.com/direct/inbox/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
};

const completeLoginIfRequired = async (p: Page) => {
  if (!p.url().includes("/accounts/login")) return;

  const cfg = getConfig();
  logger.info("Instagram login page detected");

  await p.waitForSelector(SELECTORS.emailInput, { timeout: 30_000 });
  await p.fill(SELECTORS.emailInput, cfg.instagram.username);
  await p.fill(SELECTORS.passwordInput, cfg.instagram.password);
  await p.click(SELECTORS.submitButton);

  const otpUrlPattern = /\/auth_platform\/codeentry\//;
  let requiresOtp = otpUrlPattern.test(p.url());

  if (!requiresOtp) {
    requiresOtp = await p
      .waitForURL(otpUrlPattern, { timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
  }

  if (requiresOtp) {
    await p.waitForSelector(SELECTORS.emailInput, { timeout: 30_000 });
    logger.info("Instagram 2FA code required; waiting for dashboard OTP submission");

    const code = await waitForOtpCode();
    await p.fill(SELECTORS.emailInput, code);
    await p.click(SELECTORS.continueButton);
  }

  await p.waitForURL(/\/direct\//, { timeout: 60_000 }).catch(() => undefined);

  if (p.url().includes("/accounts/login")) {
    throw new Error(
      "Instagram login did not complete. Check credentials, 2FA, or any checkpoint in the browser session.",
    );
  }

  if (p.url().includes("/challenge/") || p.url().includes("/auth_platform/recaptcha/")) {
    throw new Error(
      "Instagram requires an additional security checkpoint. Complete it through an approved browser flow before retrying.",
    );
  }
};

let sessionInitPromise: Promise<void> | null = null;

export async function initInstagramSession() {
  if (sessionInitPromise) return sessionInitPromise;

  if (isPageUsable(page)) {
    if (!isTabPoolInitialized() && context) {
      initTabPool(context, page, { onPageCreated: attachPageResponses });
    }
    return;
  }

  const init = (async () => {
    const { page: p } = await connectBrowser();
    const cfg = getConfig();

    resetMailbox();
    page = p;
    attach(p);

    await navigateToInbox(p);
    await completeLoginIfRequired(p);

    if (!p.url().includes("/direct/")) {
      await navigateToInbox(p);
    }

    startPolling(p);

    let ids = getStartupConversationIds(cfg.instagram.chatIds);

    if (!ids.length) {
      logger.info("No configured startup conversation IDs; waiting for inbox data");
      await waitMailbox();
      ids = getStartupConversationIds(cfg.instagram.chatIds);
    }

    if (!ids.length) {
      throw new Error(
        "Instagram inbox loaded, but no startup conversations were found. Check chatIds and inbox parsing.",
      );
    }

    if (!context) {
      throw new Error("Instagram browser context unavailable");
    }

    initTabPool(context, p, { onPageCreated: attachPageResponses });

    // Open the most recent chat in the primary tab and wait for its composer
    // and message groups before considering it ready.
    await ensureChatPage(ids[0]);
  })();

  sessionInitPromise = init;
  try {
    await init;
  } finally {
    if (sessionInitPromise === init) sessionInitPromise = null;
  }
}

export async function disconnectBrowser() {
  stopPolling();
  pendingOtpResolver = null;
  pendingOtpRequestedAt = null;
  sessionInitPromise = null;
  resetTabPool();

  const currentBrowser = browser;

  page = null;
  context = null;
  browser = null;

  if (currentBrowser) {
    await currentBrowser.close().catch((error) => {
      logger.debug("Error disconnecting from Chromium CDP", {
        error: String(error),
      });
    });
  }

  logger.info("Chromium CDP connection disconnected");
}
