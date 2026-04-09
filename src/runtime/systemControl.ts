import logger from "@/utils/logger.js";

interface SystemControlState {
  paused: boolean;
  browserReloading: boolean;
  browserReloadingAt: number | null;
}

const state: SystemControlState = {
  paused: false,
  browserReloading: false,
  browserReloadingAt: null,
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
