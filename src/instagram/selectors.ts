/**
 * Instagram selectors — single source of truth.
 *
 * Every CSS / aria / text selector the bot uses is defined here.
 * If Instagram's DOM changes, only this file needs updating.
 */

const SELECTORS = Object.freeze({
  // Chat / Conversation view
  messageGroup: ".x13dflua.x19991ni",
  messageText: 'div[dir="auto"], span[dir="auto"]',
  messageInput: '[role="textbox"][aria-label]',
  sendButton: '[role="button"][type="submit"], button[type="submit"]',

  // Reply detection
  replyQuote: ".x1f6kntn.x1btupbp.x1mzt3pk.x14ctfv",

  // General / shared
  notNowButton: 'button:has-text("Not Now")',
  closeModalButton: '[aria-label="Close"], [aria-label="Dismiss"]',
});

export type Selectors = typeof SELECTORS;
export default SELECTORS;
