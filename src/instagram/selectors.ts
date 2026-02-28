/**
 * Instagram selectors — single source of truth.
 *
 * Every CSS / aria / text selector the bot uses is defined here.
 * If Instagram's DOM changes, only this file needs updating.
 */

const SELECTORS = Object.freeze({
  // Login
  emailInput: 'input[type="text"][name="email"]',
  passwordInput: 'input[type="password"][name="pass"]',
  submitButton: 'div[role="button"][aria-label="Log In"]',

  // Chat / Conversation view
  messageGroup: "div.x13dflua.x19991ni",
  messageText: 'div[dir="auto"], span[dir="auto"]',
  messageInput: '[role="textbox"][aria-label]',
  sendButton: '[role="button"],div:has-text("Send")',
  replyButton: 'svg[role="img"][aria-label^="Reply to message from "]',

  // Reply detection
  replyQuote: "div.x1f6kntn.x1btupbp.x1mzt3pk.x14ctfv",

  // General / shared
  saveInfoButton: 'button:has-text("Save info")',
  notNowButton: 'button:has-text("Not Now")',
  closeModalButton: '[aria-label="Close"], [aria-label="Dismiss"]',
});

export type Selectors = typeof SELECTORS;
export default SELECTORS;
