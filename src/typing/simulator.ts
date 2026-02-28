import type { Page } from "playwright";
import SELECTORS from "../instagram/selectors.js";
import { sleep } from "../utils/delay.js";
import getConfig from "../config/index.js";

export function simulateTyping(page: Page) {
  let stopped = false;

  const run = (async () => {
    const input = page.locator(SELECTORS.messageInput).first();
    await input.click({ timeout: 5_000 });
    await input.pressSequentially(".", { delay: 0 });
    while (!stopped) {
      await sleep(500);
      await input.pressSequentially(".", { delay: 0 });
    }
    await input.fill("");
  })().catch(() => {});

  return {
    stop: async () => {
      await sleep(getConfig().typing.postResponseDelayMs);
      stopped = true;
      await run;
    },
  };
}
