import fs from "fs";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import getConfig from "@/runtime/index.js";
import { attachDataMidsForRecentWindow } from "@/automation/chat.js";
import { getStartupConversationIds } from "@/db/queries/conversations.js";
import SELECTORS from "@/instagram/selectors.js";
import { initMailbox, initThread, parseWebsocketFrame } from "@/instagram/parsers.js";

let context: BrowserContext | null = null;
let page: Page | null = null;
let polling: NodeJS.Timeout | null = null;

let mailboxReady = false;
let mailboxResolve: (() => void) | null = null;
let mailboxPromise = new Promise<void>((r) => (mailboxResolve = r));

const resetMailbox = () => {
  mailboxReady = false;
  mailboxPromise = new Promise<void>((r) => (mailboxResolve = r));
};

const markMailbox = () => {
  if (mailboxReady) return;
  mailboxReady = true;
  mailboxResolve?.();
  mailboxResolve = null;
};

const waitMailbox = (t = 45000) =>
  mailboxReady
    ? Promise.resolve()
    : Promise.race([
        mailboxPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("Mailbox timeout")), t)),
      ]);

const startPolling = (p: Page) => {
  if (polling) clearInterval(polling);
  polling = setInterval(() => handleDialogs(p).catch(() => {}), 2000);
};

const stopPolling = () => {
  if (!polling) return;
  clearInterval(polling);
  polling = null;
};

export async function connectBrowser() {
  if (context) return { context };

  const cfg = getConfig();
  fs.mkdirSync(cfg.chromium.profileDir, { recursive: true });

  context = await chromium.launchPersistentContext(cfg.chromium.profileDir, {
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
    stopPolling();
    page = null;
    context = null;
  });

  return { context };
}

const attach = (p: Page) => {
  p.removeAllListeners();

  p.on("close", () => {
    stopPolling();
    page = null;
  });

  p.on("crash", () => {
    stopPolling();
    page = null;
  });

  p.on("response", async (res) => {
    try {
      if (
        !res.url().includes("/api/graphql") ||
        res.status() !== 200 ||
        res.request().method() !== "POST"
      )
        return;

      const body = res.request().postData();
      if (!body) return;

      if (body.includes("PolarisDirectInboxQuery")) {
        initMailbox(await res.json());
        markMailbox();
        return;
      }

      if (body.includes("IGDThreadDetailMainViewContainerQuery")) {
        const chatId = initThread(await res.json());
        if (chatId) await attachDataMidsForRecentWindow(chatId, 8);
      }
    } catch {}
  });

  p.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      try {
        const payload = f.payload.toString("utf8");
        if (!payload.includes("/ig_message_sync")) return;
        parseWebsocketFrame(payload, getConfig().instagram.chatIds);
      } catch {}
    });
  });
};

export const getPage = () => {
  if (!page || page.isClosed()) throw new Error("No session");
  return page;
};

export const ensureSession = async () => {
  if (!page || page.isClosed()) await initInstagramSession();
  return page!;
};

export const handleDialogs = async (p: Page) => {
  for (const sel of [
    SELECTORS.continueButton,
    SELECTORS.saveInfoButton,
    SELECTORS.notNowButton,
  ]) {
    const el = p.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click().catch(() => {});
      return;
    }
  }
};

const openChat = async (p: Page, id: string) => {
  await p.goto(`https://www.instagram.com/direct/t/${id}/`, { waitUntil: "domcontentloaded" });
  await p.waitForURL(new RegExp(`/direct/t/${id}`));
  await p.waitForSelector(SELECTORS.messageInput);
};

export async function initInstagramSession() {
  if (page && !page.isClosed()) return;

  const { context: ctx } = await connectBrowser();
  const cfg = getConfig();

  const p = ctx.pages()[0] ?? (await ctx.newPage());
  page = p;

  resetMailbox();
  attach(p);

  let ids = getStartupConversationIds(cfg.instagram.chatIds);

  if (ids.length) {
    await openChat(p, ids[0]).catch(() => {});
  } else {
    await p.goto("https://www.instagram.com/direct/inbox/");
  }

  if (p.url().includes("/accounts/login")) {
    await p.waitForSelector(SELECTORS.emailInput);
    await p.fill(SELECTORS.emailInput, cfg.instagram.username);
    await p.fill(SELECTORS.passwordInput, cfg.instagram.password);
    await p.click(SELECTORS.submitButton);
    await p.waitForURL(/\/direct\//).catch(() => {});
  }

  if (!p.url().includes("/direct/")) {
    await p.goto("https://www.instagram.com/direct/inbox/");
  }

  startPolling(p);

  if (!ids.length) {
    await waitMailbox();
    ids = getStartupConversationIds(cfg.instagram.chatIds);

    if (!ids.length) throw new Error("No chat");

    await openChat(p, ids[0]);
  }
}

export async function disconnectBrowser() {
  stopPolling();
  await context?.close().catch(() => {});
  context = null;
  page = null;
}