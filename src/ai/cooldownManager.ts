/**
 * Per-user cooldown manager.
 * Prevents rapid repeated AI calls from the same user.
 */

import config from "../config/index.js";
import logger from "../utils/logger.js";

const cooldowns = new Map<string, number>();

export function isOnCooldown(userId: string): boolean {
  const last = cooldowns.get(userId);
  if (!last) return false;

  const elapsed = Date.now() - last;
  const remaining = config.cooldown.userCooldownMs - elapsed;

  if (remaining > 0) {
    logger.debug("User on cooldown", { userId, remainingMs: remaining });
    return true;
  }

  return false;
}

export function recordRequest(userId: string): void {
  cooldowns.set(userId, Date.now());
}

export function getRemainingCooldown(userId: string): number {
  const last = cooldowns.get(userId);
  if (!last) return 0;
  return Math.max(0, config.cooldown.userCooldownMs - (Date.now() - last));
}

export function pruneCooldowns(): void {
  const now = Date.now();
  for (const [userId, ts] of cooldowns) {
    if (now - ts > config.cooldown.userCooldownMs * 2) {
      cooldowns.delete(userId);
    }
  }
}
