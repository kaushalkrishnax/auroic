/* *
 * Stable Instagram selectors.
 * Uses valid CSS selectors compatible with Playwright.
 */


const SELECTORS = Object.freeze({
  // AUTH
  emailInput: 'input[name="username"], input[name="email"]',
  passwordInput: 'input[name="password"], input[name="pass"]',
  submitButton: 'button[type="submit"], div[role="button"][aria-label*="Log"]',
  continueButton: 'div[role="button"][aria-label*="Continue"]',
  notNowButton: 'button:has-text("Not Now"), div[role="button"]:has-text("Not Now")',
  saveInfoButton: 'button:has-text("Save Info"), div[role="button"]:has-text("Save Info")',

  // COMPOSER ACTIONS
  voiceNoteButton: 'div[role="button"]:has(svg[aria-label="Voice Clip"])',
  sendVoiceNoteButton: 'div[role="button"][aria-label="Send"]',

  // NAVIGATION
  threadList: 'div[role="navigation"][aria-label="Thread list"]',
  conversation: 'main[role="main"]',
  dialog: '[role="dialog"]',

  // CONVERSATION HEADER
  conversationInfoButton: 'div[role="button"][aria-label="Conversation information"]',

  // MESSAGE LIST
  messageList: '[data-pagelet="IGDMessagesList"]',

  // MESSAGE STRUCTURE
  //
  // Each message row wraps the message content and its "[aria-label="Message actions"]"
  // toolbar. Rows in Instagram Web are div[role="group"][tabindex="-1"] (or article
  // elements on certain builds). data-mid is stamped on the row so actions can target
  // an individual message.
  messageContainer: 'div[role="group"][tabindex="-1"], div[role="group"]:has([aria-label="Message actions"]), article[role="article"][aria-roledescription="message"]',
  messageText: 'div[dir="auto"]',

  // MESSAGE ACTIONS
  //
  // All three buttons must be scoped to a single message's action group
  // (row.locator(SELECTORS.messageActionsGroup)), never queried page-wide.
  // messageActionsGroup is the toolbar; moreOptionsButton is the three-dot
  // button inside it — they are distinct concepts.
  messageActionsGroup: '[role="group"][aria-label="Message actions"]',
  reactButton: 'div[role="button"][aria-label^="React to message"], div[role="button"][aria-label*="React" i]',
  replyButton: 'div[role="button"][aria-label^="Reply to message"], div[role="button"][aria-label*="Reply" i]',
  moreOptionsButton: 'div[role="button"][aria-label^="See more options for message"], div[role="button"][aria-label*="more options" i]',

  // COMPOSER
  messageComposer: '[data-pagelet="IGDComposerForCannes"]',
  messageInput: '[role="textbox"][contenteditable="true"][data-lexical-editor="true"], [role="textbox"][contenteditable="true"]',

  // COMPOSER ACTIONS
  chooseEmojiButton: 'div[role="button"]:has(svg[aria-label="Choose an emoji"])',
  mediaButton: 'div[role="button"]:has(svg[aria-label="Add Photo or Video"])',
  gifStickerButton: 'div[role="button"]:has(svg[aria-label="Choose a GIF or sticker"])',

  // GIF / STICKER PICKER
  //
  // Picker lookups are scoped to a visible dialog locator. Do not prefix these
  // selectors with "[role="dialog"] when used with dialog.locator(), and never
  // run them page-wide.
  gifDialog: '[role="dialog"]',
  mediaTabList: '[role="tablist"]',
  mediaTab: '[role="tab"]',
  gifSearchInput: 'input[name="GifSearch"]',

  // SEARCH INPUTS
  emojiSearchInput: 'input[placeholder="Search emoji"], input[aria-label*="Search emoji"]',
  stickerSearchInput: 'input[placeholder="Search stickers"], input[aria-label*="Search stickers"]',
  musicSearchInput: 'input[placeholder="Search music"], input[aria-label*="Search music"]',

  // MEDIA PICKER
  // Result tiles, scoped to the picker dialog. Never used page-wide.
  mediaItemButton: 'div[role="button"]:not([role="tab"]):has(img), div[role="button"]:not([role="tab"]):has(video)',
  musicSendButton:
    'div[role="button"]:has(svg path[d^="m22.887"]), div[role="button"]:has(svg[data-name*="Layer 1"])',

  // MODALS
  closeModal: '[aria-label*="Close"], [aria-label*="Dismiss"]',
});

export type Selectors = typeof SELECTORS;
export default SELECTORS;