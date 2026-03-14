/**
 * Stable Instagram selectors.
 * Only selectors required for the runtime are included.
 */

const SELECTORS = Object.freeze({
  emailInput: 'input[name="username"], input[name="email"]',
  passwordInput: 'input[name="password"], input[name="pass"]',

  submitButton: 'button[type="submit"], div[role="button"][aria-label="Log In"]',
  continueButton: 'div[role="button"][aria-label="Continue"]',

  notNowButton: "button",
  saveInfoButton: "button",

  threadList: 'div[aria-label="Thread list"][role="navigation"]',
  messageList: '[data-pagelet="IGDMessagesList"]',
  tabList: 'div[role="tablist"]',
  dialog: 'div[role="dialog"]',

  messageGroup: 'div[role="group"]',
  messageText: '[dir="auto"]',

  messageInput: '[role="textbox"]',
  emojiSearchInput:
    'input[placeholder="Search emoji"], input[aria-label="Search emoji"]',
  stickerSearchInput:
    'input[placeholder="Search stickers"], input[aria-label="Search stickers"]',
  musicSearchInput:
    'input[placeholder="Search music"], input[aria-label="Search music"]',
  gifSearchInput:
    'input[placeholder="Search GIPHY"], input[aria-label="Search GIPHY"]',

  replyButton: 'div[role="button"]:has(svg[aria-label*="Reply"])',
  reactButton: 'div[role="button"]:has(svg[aria-label*="React"])',
  mediaButton:
    'div[role="button"]:has(svg[aria-label="Choose a GIF or sticker"])',
  mediaTabButton: 'a[role="tab"]:has(svg)',
  mediaItemButton: 'div[role="button"]:has(img), div[role="button"]:has(video)',
  chooseEmojiButton: 'svg[aria-label="Choose an emoji"]',

  closeModal: '[aria-label="Close"], [aria-label="Dismiss"]',
});

export type Selectors = typeof SELECTORS;
export default SELECTORS;
