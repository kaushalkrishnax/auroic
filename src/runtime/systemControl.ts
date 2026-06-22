import logger from "@/utils/logger.js";

/**
 * Priority levels for automation tasks
 */
export enum AutomationPriority {
  PASSIVE = 0,
  BOT_MESSAGE = 1,
  COMMAND = 2,
}

/**
 * Per-chatId automation context
 */
interface ChatAutomationContext {
  currentPriority: AutomationPriority;
  suspendedAutomation: boolean;
  suspendedAt: number | null;
}

interface SystemControlState {
  paused: boolean;
  browserReloading: boolean;
  browserReloadingAt: number | null;
  chatContexts: Map<string, ChatAutomationContext>;
}

const state: SystemControlState = {
  paused: false,
  browserReloading: false,
  browserReloadingAt: null,
  chatContexts: new Map(),
};

export function getSystemControlState(): {
  paused: boolean;
  browserReloading: boolean;
  browserReloadingAt: number | null;
} {
  return {
    paused: state.paused,
    browserReloading: state.browserReloading,
    browserReloadingAt: state.browserReloadingAt,
  };
}

export function isSystemPaused(): boolean {
  return state.paused;
}

export function pauseSystem(reason = "dashboard-request"): boolean {
  if (state.paused) return false;
  state.paused = true;
  logger.warn("System paused", { reason });
  return true;
}

export function resumeSystem(reason = "dashboard-request"): boolean {
  if (!state.paused) return false;
  state.paused = false;
  logger.info("System resumed", { reason });
  return true;
}

export function beginBrowserReload(reason = "dashboard-request"): boolean {
  if (state.browserReloading) return false;
  state.browserReloading = true;
  state.browserReloadingAt = Date.now();
  logger.warn("Browser reload requested", { reason });
  return true;
}

export function endBrowserReload(
  reason = "dashboard-request",
  success = true,
): void {
  state.browserReloading = false;
  state.browserReloadingAt = null;
  logger.info("Browser reload finished", { reason, success });
}

/**
 * Get or create chat automation context
 */
function getChatContext(chatId: string): ChatAutomationContext {
  let context = state.chatContexts.get(chatId);
  if (!context) {
    context = {
      currentPriority: AutomationPriority.PASSIVE,
      suspendedAutomation: false,
      suspendedAt: null,
    };
    state.chatContexts.set(chatId, context);
  }
  return context;
}

/**
 * Check if a higher priority task is active for a chat
 */
export function hasHigherPriorityTask(chatId: string): boolean {
  const context = getChatContext(chatId);
  return context.currentPriority > AutomationPriority.PASSIVE;
}

/**
 * Set the current priority for a chat
 */
export function setChatPriority(
  chatId: string,
  priority: AutomationPriority,
): void {
  const context = getChatContext(chatId);
  context.currentPriority = priority;
  logger.debug("Chat priority updated", {
    chatId,
    priority,
    currentPriority: context.currentPriority,
  });
}

/**
 * Pause automation for a specific chat
 */
export function pauseChatAutomation(
  chatId: string,
  reason = "higher-priority-task",
): boolean {
  const context = getChatContext(chatId);
  if (context.suspendedAutomation) {
    logger.debug("Chat automation already paused", { chatId, reason });
    return false;
  }
  context.suspendedAutomation = true;
  context.suspendedAt = Date.now();
  logger.info("Chat automation paused", { chatId, reason });
  return true;
}

/**
 * Resume automation for a specific chat
 */
export function resumeChatAutomation(
  chatId: string,
  reason = "lower-priority-task-completed",
): boolean {
  const context = getChatContext(chatId);
  if (!context.suspendedAutomation) {
    logger.debug("Chat automation not paused", { chatId, reason });
    return false;
  }
  context.suspendedAutomation = false;
  context.suspendedAt = null;
  logger.info("Chat automation resumed", { chatId, reason });
  return true;
}

/**
 * Get chat automation status
 */
export function getChatAutomationStatus(chatId: string): {
  currentPriority: AutomationPriority;
  suspendedAutomation: boolean;
  suspendedAt: number | null;
} {
  const context = getChatContext(chatId);
  return {
    currentPriority: context.currentPriority,
    suspendedAutomation: context.suspendedAutomation,
    suspendedAt: context.suspendedAt,
  };
}

/**
 * Clear chat automation context (cleanup)
 */
export function clearChatContext(chatId: string): void {
  state.chatContexts.delete(chatId);
  logger.debug("Chat automation context cleared", { chatId });
}
