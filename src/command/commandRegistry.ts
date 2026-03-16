import type { Page } from "playwright";
import { sendGIF, sendSticker } from "@/automation/chat.js";
import logger from "@/utils/logger.js";

/**
 * Command handler function type
 * @param page - Playwright page instance
 * @param query - The extracted query text (input with command words stripped)
 * @param conversationId - The conversation ID where the command was triggered
 */
export type CommandHandler = (
  page: Page,
  query: string,
  conversationId: string,
) => Promise<void>;

/**
 * Command definition with metadata and handler
 */
export interface CommandDefinition {
  name: string;
  actionType: "text" | "ignore" | "react" | "media";
  exampleText: string;
  commandWords: string[];
  description: string;
  handler: CommandHandler;
}

/**
 * Predefined command handlers
 */
const commandHandlers = {
  async sendGif(page: Page, query: string, conversationId: string) {
    const title = query.trim() || "funny";
    const sent = await sendGIF(title, conversationId);
    if (!sent) {
      throw new Error(`send_gif failed for query: ${title}`);
    }

    logger.info("Command handler sent GIF", {
      command: "send_gif",
      conversationId,
      query: title,
    });
  },

  async sendImage(page: Page, query: string, conversationId: string) {
    console.log(`[Command:sendImage] Query: "${query}" in ${conversationId}`);
    // TODO: Implement image search and send logic
  },

  async sendSticker(page: Page, query: string, conversationId: string) {
    const title = query.trim() || "funny";
    const sent = await sendSticker(title, conversationId);
    if (!sent) {
      throw new Error(`send_sticker failed for query: ${title}`);
    }

    logger.info("Command handler sent sticker", {
      command: "send_sticker",
      conversationId,
      query: title,
    });
  },

  async reactHeart(page: Page, query: string, conversationId: string) {
    console.log(`[Command:reactHeart] Query: "${query}" in ${conversationId}`);
    // TODO: Implement react with heart emoji to last message
  },

  async reactThumbsUp(page: Page, query: string, conversationId: string) {
    console.log(
      `[Command:reactThumbsUp] Query: "${query}" in ${conversationId}`,
    );
    // TODO: Implement react with thumbs up to last message
  },

  async reactLaugh(page: Page, query: string, conversationId: string) {
    console.log(`[Command:reactLaugh] Query: "${query}" in ${conversationId}`);
    // TODO: Implement react with laugh emoji to last message
  },

  async ignoreMessage(page: Page, query: string, conversationId: string) {
    console.log(
      `[Command:ignoreMessage] Query: "${query}" in ${conversationId}`,
    );
    // This is a no-op - just prevents response
  },

  async sendVoiceNote(page: Page, query: string, conversationId: string) {
    console.log(
      `[Command:sendVoiceNote] Query: "${query}" in ${conversationId}`,
    );
    // TODO: Implement voice note recording and send logic
  },

  async deleteLastMessage(page: Page, query: string, conversationId: string) {
    console.log(
      `[Command:deleteLastMessage] Query: "${query}" in ${conversationId}`,
    );
    // TODO: Implement delete last sent message
  },

  async editLastMessage(page: Page, query: string, conversationId: string) {
    console.log(
      `[Command:editLastMessage] Query: "${query}" in ${conversationId}`,
    );
    // TODO: Implement edit last sent message with new content
  },

  async markUnread(page: Page, query: string, conversationId: string) {
    console.log(`[Command:markUnread] Query: "${query}" in ${conversationId}`);
    // TODO: Implement mark conversation as unread
  },

  async muteConversation(page: Page, query: string, conversationId: string) {
    console.log(
      `[Command:muteConversation] Query: "${query}" in ${conversationId}`,
    );
    // TODO: Implement mute conversation
  },

  async searchMessages(page: Page, query: string, conversationId: string) {
    console.log(
      `[Command:searchMessages] Query: "${query}" in ${conversationId}`,
    );
    // TODO: Implement search within conversation
  },

  async createPoll(page: Page, query: string, conversationId: string) {
    console.log(`[Command:createPoll] Query: "${query}" in ${conversationId}`);
    // TODO: Implement poll creation
  },

  async shareLocation(page: Page, query: string, conversationId: string) {
    console.log(
      `[Command:shareLocation] Query: "${query}" in ${conversationId}`,
    );
    // TODO: Implement location sharing
  },
};

/**
 * Registry of all available commands
 */
export const COMMAND_REGISTRY: CommandDefinition[] = [
  {
    name: "send_gif",
    actionType: "media",
    exampleText: "send me a funny gif",
    commandWords: ["gif", "send"],
    description: "Search and send a GIF based on the query",
    handler: commandHandlers.sendGif,
  },
  {
    name: "send_image",
    actionType: "media",
    exampleText: "send an image of a cat",
    commandWords: ["image", "picture", "photo", "send"],
    description: "Search and send an image based on the query",
    handler: commandHandlers.sendImage,
  },
  {
    name: "send_sticker",
    actionType: "media",
    exampleText: "send a happy sticker",
    commandWords: ["sticker", "send"],
    description: "Select and send a sticker",
    handler: commandHandlers.sendSticker,
  },
  {
    name: "react_heart",
    actionType: "react",
    exampleText: "react with a heart",
    commandWords: ["react", "heart", "love"],
    description: "React to the last message with a heart emoji",
    handler: commandHandlers.reactHeart,
  },
  {
    name: "react_thumbs_up",
    actionType: "react",
    exampleText: "give a thumbs up",
    commandWords: ["thumbs", "up", "like"],
    description: "React to the last message with thumbs up",
    handler: commandHandlers.reactThumbsUp,
  },
  {
    name: "react_laugh",
    actionType: "react",
    exampleText: "react with laughter",
    commandWords: ["laugh", "lol", "haha", "react"],
    description: "React to the last message with laugh emoji",
    handler: commandHandlers.reactLaugh,
  },
  {
    name: "ignore_message",
    actionType: "ignore",
    exampleText: "ignore this message",
    commandWords: ["ignore", "skip", "nevermind"],
    description: "Ignore the message and don't respond",
    handler: commandHandlers.ignoreMessage,
  },
  {
    name: "send_voice_note",
    actionType: "media",
    exampleText: "send a voice note",
    commandWords: ["voice", "note", "audio", "send"],
    description: "Record and send a voice note",
    handler: commandHandlers.sendVoiceNote,
  },
  {
    name: "delete_last_message",
    actionType: "text",
    exampleText: "delete my last message",
    commandWords: ["delete", "remove", "message"],
    description: "Delete the last sent message",
    handler: commandHandlers.deleteLastMessage,
  },
  {
    name: "edit_last_message",
    actionType: "text",
    exampleText: "edit my last message to say hello",
    commandWords: ["edit", "change", "message"],
    description: "Edit the last sent message",
    handler: commandHandlers.editLastMessage,
  },
  {
    name: "mark_unread",
    actionType: "text",
    exampleText: "mark this as unread",
    commandWords: ["mark", "unread"],
    description: "Mark the conversation as unread",
    handler: commandHandlers.markUnread,
  },
  {
    name: "mute_conversation",
    actionType: "text",
    exampleText: "mute this conversation",
    commandWords: ["mute", "silence"],
    description: "Mute notifications for this conversation",
    handler: commandHandlers.muteConversation,
  },
  {
    name: "search_messages",
    actionType: "text",
    exampleText: "search for messages about vacation",
    commandWords: ["search", "find", "messages"],
    description: "Search for messages in the conversation",
    handler: commandHandlers.searchMessages,
  },
  {
    name: "create_poll",
    actionType: "media",
    exampleText: "create a poll about dinner options",
    commandWords: ["poll", "create", "vote"],
    description: "Create a poll in the conversation",
    handler: commandHandlers.createPoll,
  },
  {
    name: "share_location",
    actionType: "media",
    exampleText: "share my location",
    commandWords: ["location", "share", "where"],
    description: "Share your current location",
    handler: commandHandlers.shareLocation,
  },
];

/**
 * Get command handler by name
 */
export function getCommandHandler(
  commandName: string,
): CommandHandler | null {
  const command = COMMAND_REGISTRY.find((cmd) => cmd.name === commandName);
  return command?.handler ?? null;
}

/**
 * Get all command names
 */
export function getAllCommandNames(): string[] {
  return COMMAND_REGISTRY.map((cmd) => cmd.name);
}
