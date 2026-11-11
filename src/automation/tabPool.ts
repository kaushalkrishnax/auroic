/**
 * Shared Instagram tab pool.
 *
 * Every active chat owns exactly one Playwright page inside the existing
 * authenticated browser context. Automation always runs on the page assigned
 * to the event's chat, so an action can never be delivered through another
 * conversation's tab.
 */

import type { BrowserContext, Page } from "playwright-core";
import SELECTORS from "@/instagram/selectors.js";
import logger from "@/utils/logger.js";
import { sleep } from "@/utils/delay.js";

export const MAX_TABS = 5;
const INACTIVITY_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 20_000;
const BUSY_WAIT_MS = 30_000;
const BUSY_RETRY_MS = 250;

class TabPoolBusyError extends Error {}

interface TabEntry {
  page: Page;
  chatId: string | null;
  ready: boolean;
  initializing: Promise<Page> | null;
  lastActivityAt: number;
  /** Queued or executing automation tasks. Busy tabs are never rotated/closed. */
  busy: number;
}

interface TabPoolHooks {
  onPageCreated?: (page: Page) => void;
}

class TabPool {
  private readonly tabs = new Map<Page, TabEntry>();
  private readonly chatToPage = new Map<string, Page>();
  private readonly queues = new Map<Page, Promise<void>>();
  private allocationQueue: Promise<void> = Promise.resolve();
  private readonly cleanupTimer: NodeJS.Timeout;
  private primaryPage: Page | null;

  constructor(
    private readonly context: BrowserContext,
    primaryPage: Page,
    private readonly hooks: TabPoolHooks = {},
  ) {
    this.primaryPage = primaryPage;
    this.register(primaryPage);

    this.cleanupTimer = setInterval(
      () => this.sweepInactiveTabs(),
      CLEANUP_INTERVAL_MS,
    );
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  get size(): number {
    return this.tabs.size;
  }

  /**
   * Adopts a replacement primary page after a reconnect, keeping other chat
   * mappings intact. A page already known to the pool is only re-marked primary.
   */
  adoptPrimary(page: Page): void {
    this.primaryPage = page;
    if (this.tabs.has(page)) return;
    this.register(page);
    this.hooks.onPageCreated?.(page);
  }

  getAssignedPage(chatId: string): Page | null {
    const page = this.chatToPage.get(chatId);
    if (!page || page.isClosed()) return null;
    const entry = this.tabs.get(page);
    return entry?.ready ? page : null;
  }

  requireChatPage(chatId: string): Page {
    const page = this.getAssignedPage(chatId);
    if (!page) {
      throw new Error(`No active tab assigned to chat ${chatId}`);
    }
    return page;
  }

  /**
   * Updates the activity timestamp for an assigned chat. Called for every
   * incoming message so rotation always picks the least recently active chat.
   */
  noteActivity(chatId: string, timestampMs?: number): void {
    const incoming = Number(timestampMs);
    if (!Number.isFinite(incoming) || incoming <= 0) return;

    const page = this.chatToPage.get(chatId);
    if (!page) return;
    const entry = this.tabs.get(page);
    if (!entry) return;

    entry.lastActivityAt = Math.max(entry.lastActivityAt, incoming);
  }

  async ensureChatPage(chatId: string, timestampMs?: number): Promise<Page> {
    const deadline = Date.now() + BUSY_WAIT_MS;

    for (;;) {
      const assigned = this.assignedEntry(chatId);

      if (assigned) {
        if (assigned.initializing) {
          // Events that arrive while the tab is still loading wait for the
          // shared initialization promise, preserving per-chat ordering.
          return assigned.initializing;
        }

        if (assigned.ready && this.isOnChat(assigned.page, chatId)) {
          this.noteActivity(chatId, timestampMs);
          return assigned.page;
        }

        if (assigned.ready) {
          // Instagram redirected the tab away from the assigned chat; treat it
          // as unready instead of sending through the wrong screen.
          logger.warn(
            "Assigned tab drifted away from its chat; re-navigating",
            { chatId, url: assigned.page.url() },
          );
        }

        this.unassign(chatId);
      }

      try {
        const entry = await this.withAllocationLock(() =>
          this.reserve(chatId, timestampMs),
        );
        return await this.awaitReady(entry, chatId);
      } catch (err) {
        if (!(err instanceof TabPoolBusyError)) throw err;
        if (Date.now() >= deadline) throw err;

        logger.info("Tab pool busy; waiting for an idle tab", { chatId });
        await sleep(BUSY_RETRY_MS);
      }
    }
  }

  private isOnChat(page: Page, chatId: string): boolean {
    return page.url().includes(`/direct/t/${chatId}`);
  }

  private assignedEntry(chatId: string): TabEntry | null {
    const page = this.chatToPage.get(chatId);
    if (!page || page.isClosed()) return null;
    return this.tabs.get(page) ?? null;
  }

  /**
   * Serializes tab selection so concurrent events can never create a sixth tab
   * or reserve the same victim twice. Only selection runs under the lock; the
   * navigation/readiness wait happens outside it so different chats load
   * independently.
   */
  private async withAllocationLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.allocationQueue;
    let release!: () => void;
    this.allocationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  /**
   * Picks an available tab (or rotates the least recently active one), maps it
   * to the chat, and starts navigation. Callers must await `awaitReady`.
   */
  private async reserve(
    chatId: string,
    timestampMs?: number,
  ): Promise<TabEntry> {
    const existing = this.assignedEntry(chatId);
    if (existing) return existing;

    const entry = await this.pickEntry(chatId);

    if (entry.chatId) this.unassign(entry.chatId);

    entry.chatId = chatId;
    entry.ready = false;
    entry.lastActivityAt =
      Number.isFinite(Number(timestampMs)) && Number(timestampMs) > 0
        ? Number(timestampMs)
        : Date.now();
    this.chatToPage.set(chatId, entry.page);

    entry.initializing = this.initialize(entry, chatId);
    return entry;
  }

  /**
   * Waits for a reserved tab to become ready. On failure nothing is sent
   * through the tab, its mapping is dropped, and other chats are untouched.
   */
  private async awaitReady(entry: TabEntry, chatId: string): Promise<Page> {
    const init = entry.initializing;
    if (!init) {
      if (entry.ready && this.isOnChat(entry.page, chatId)) return entry.page;
      throw new Error(`Chat tab for ${chatId} is not ready`);
    }

    try {
      return await init;
    } catch (err) {
      if (this.chatToPage.get(chatId) === entry.page) {
        this.chatToPage.delete(chatId);
      }
      if (entry.chatId === chatId) {
        entry.chatId = null;
        entry.ready = false;
      }
      logger.error("Chat tab failed to become ready", {
        chatId,
        error: (err as Error).message,
      });
      throw err;
    } finally {
      if (entry.initializing === init) entry.initializing = null;
    }
  }

  private async pickEntry(chatId: string): Promise<TabEntry> {
    const free = [...this.tabs.values()].find(
      (entry) => !entry.chatId && !entry.page.isClosed(),
    );
    if (free) return free;

    if (this.tabs.size < MAX_TABS) {
      const page = await this.context.newPage();
      const entry = this.register(page);
      this.hooks.onPageCreated?.(page);
      return entry;
    }

    const candidates = [...this.tabs.values()]
      .filter(
        (entry) =>
          entry.chatId !== null &&
          entry.page !== this.primaryPage &&
          entry.busy === 0 &&
          !entry.initializing &&
          !entry.page.isClosed(),
      )
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);

    const victim = candidates[0];
    if (!victim) {
      throw new TabPoolBusyError(
        `Tab pool is full (${MAX_TABS}) and no idle tab can be reassigned for chat ${chatId}`,
      );
    }

    logger.info("Rotating least recently active chat tab", {
      chatId,
      reassignedChatId: victim.chatId,
      lastActivityAt: victim.lastActivityAt,
    });
    return victim;
  }

  private async initialize(entry: TabEntry, chatId: string): Promise<Page> {
    const page = entry.page;
    await page.goto(`https://www.instagram.com/direct/t/${chatId}/`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    const input = page.locator(SELECTORS.messageInput).first();
    await input.waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });

    const groups = page
      .locator(SELECTORS.messageList)
      .locator(SELECTORS.messageGroup);
    await groups.first().waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });

    entry.ready = true;
    logger.info("Chat tab ready", {
      chatId,
      poolSize: this.tabs.size,
      primary: page === this.primaryPage,
    });
    return page;
  }

  /**
   * Runs an action on the chat's page with per-page serialization. The page
   * ownership is re-checked immediately before the task starts so a rotated or
   * closed tab can never deliver through the wrong conversation.
   */
  async runWithChatPage<T>(
    chatId: string,
    task: () => Promise<T>,
    timestampMs?: number,
  ): Promise<T> {
    const page = await this.ensureChatPage(chatId, timestampMs);
    return this.runOnPage(page, chatId, task);
  }

  private async runOnPage<T>(
    page: Page,
    chatId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const entry = this.tabs.get(page);
    if (entry) entry.busy += 1;

    const previous = this.queues.get(page) ?? Promise.resolve();
    const current = previous.then(async () => {
      if (
        page.isClosed() ||
        this.chatToPage.get(chatId) !== page ||
        !this.isOnChat(page, chatId)
      ) {
        throw new Error(
          `Tab ownership changed before action for chat ${chatId}`,
        );
      }
      return task();
    });

    const tracked = current.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(page, tracked);

    try {
      return await current;
    } finally {
      if (entry) entry.busy = Math.max(0, entry.busy - 1);
      if (this.queues.get(page) === tracked) this.queues.delete(page);
    }
  }

  private sweepInactiveTabs(): void {
    const now = Date.now();

    for (const entry of [...this.tabs.values()]) {
      if (entry.page === this.primaryPage) continue;
      if (!entry.chatId) continue;
      if (entry.busy > 0 || entry.initializing) continue;
      if (now - entry.lastActivityAt < INACTIVITY_MS) continue;

      const chatId = entry.chatId;
      const idleMs = now - entry.lastActivityAt;
      this.unassign(chatId);
      // Forget the page before closing so it cannot be handed out while the
      // close is still in flight.
      this.tabs.delete(entry.page);
      this.queues.delete(entry.page);
      void entry.page.close().catch(() => undefined);
      logger.info("Closed inactive chat tab", {
        chatId,
        idleMs,
        poolSize: this.tabs.size,
      });
    }
  }

  private unassign(chatId: string): void {
    const page = this.chatToPage.get(chatId);
    if (!page) return;
    this.chatToPage.delete(chatId);
    const entry = this.tabs.get(page);
    if (!entry) return;
    entry.chatId = null;
    entry.ready = false;
    entry.lastActivityAt = Date.now();
  }

  private register(page: Page): TabEntry {
    const entry: TabEntry = {
      page,
      chatId: null,
      ready: false,
      initializing: null,
      lastActivityAt: Date.now(),
      busy: 0,
    };
    this.tabs.set(page, entry);

    page.on("close", () => this.removePage(page));
    return entry;
  }

  private removePage(page: Page): void {
    const entry = this.tabs.get(page);
    if (!entry) return;
    if (entry.chatId) this.chatToPage.delete(entry.chatId);
    this.tabs.delete(page);
    this.queues.delete(page);
    if (this.primaryPage === page) this.primaryPage = null;
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.chatToPage.clear();
    this.tabs.clear();
    this.queues.clear();
    this.primaryPage = null;
  }
}

let pool: TabPool | null = null;

export function initTabPool(
  context: BrowserContext,
  primaryPage: Page,
  hooks: TabPoolHooks = {},
): void {
  if (pool) {
    pool.adoptPrimary(primaryPage);
    return;
  }
  pool = new TabPool(context, primaryPage, hooks);
}

export function isTabPoolInitialized(): boolean {
  return pool !== null;
}

export function resetTabPool(): void {
  pool?.dispose();
  pool = null;
}

export function getTabPool(): TabPool {
  if (!pool) throw new Error("Instagram tab pool is not initialized");
  return pool;
}

export function getAssignedPage(chatId: string): Page | null {
  return pool?.getAssignedPage(chatId) ?? null;
}

export function requireChatPage(chatId: string): Page {
  return getTabPool().requireChatPage(chatId);
}

export function noteChatActivity(chatId: string, timestampMs?: number): void {
  pool?.noteActivity(chatId, timestampMs);
}

export async function ensureChatPage(
  chatId: string,
  timestampMs?: number,
): Promise<Page> {
  return getTabPool().ensureChatPage(chatId, timestampMs);
}

export async function runWithChatPage<T>(
  chatId: string,
  task: () => Promise<T>,
  timestampMs?: number,
): Promise<T> {
  return getTabPool().runWithChatPage(chatId, task, timestampMs);
}
