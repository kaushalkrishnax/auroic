/* *
 * Stable Instagram selectors.
 * Uses valid CSS selectors compatible with Playwright.
 */

const SELECTORS = Object.freeze({
  /* AUTH */

  emailInput: 'input[name="username"], input[name="email"]',

  passwordInput: 'input[name="password"], input[name="pass"]',

  submitButton: 'button[type="submit"], div[role="button"][aria-label*="Log"]',

  continueButton: 'div[role="button"][aria-label*="Continue"]',

  notNowButton:
    'button:has-text("Not Now"), div[role="button"]:has-text("Not Now")',

  saveInfoButton:
    'button:has-text("Save Info"), div[role="button"]:has-text("Save Info")',

  voiceNoteButton: 'div[role="button"]:has(svg[aria-label*="Voice Clip"])',

  sendVoiceNoteButton: 'div[role="button"]:has-text("Send")',

  /* NAVIGATION */

  threadList: 'div[aria-label="Thread list"][role="navigation"]',

  messageList: '[data-pagelet="IGDMessagesList"]',

  tabList: 'div[role="tablist"]',

  dialog: 'div[role="dialog"]',

  /* MESSAGE STRUCTURE */

  messageGroup: 'div[role="group"]',

  messageText: '[dir="auto"]',

  messageInput: '[role="textbox"]',

  messageComposer: 'div[data-pagelet="IGDComposerForCannes"]',

  /* SEARCH INPUTS */

  emojiSearchInput:
    'input[placeholder="Search emoji"], input[aria-label*="Search emoji"]',

  stickerSearchInput:
    'input[placeholder="Search stickers"], input[aria-label*="Search stickers"]',

  musicSearchInput:
    'input[placeholder="Search music"], input[aria-label*="Search music"]',

  gifSearchInput:
    'input[placeholder="Search GIPHY"], input[aria-label*="Search GIPHY"]',

  /* MESSAGE ACTIONS */

  replyButton: 'div[role="button"]:has(svg[aria-label*="Reply"])',

  reactButton: 'div[role="button"]:has(svg[aria-label*="React"])',

  /* MEDIA PICKER */

  mediaButton:
    'div[role="button"]:has(svg[aria-label*="GIF"]), div[role="button"]:has(svg[aria-label*="sticker"])',

  mediaTabButton: 'a[role="tab"]:has(svg)',

  mediaItemButton: 'div[role="button"]:has(img), div[role="button"]:has(video)',

  musicSendButton:
    'div[role="button"]:has(div[role="button"]:has(svg[data-name*="Layer 1"]))',

  /* EMOJI PICKER */

  chooseEmojiButton: 'svg[aria-label*="emoji"]',

  closeModal: '[aria-label*="Close"], [aria-label*="Dismiss"]',
});

export type Selectors = typeof SELECTORS;
export default SELECTORS;
