import { sendGIF, sendSticker } from "@/automation/chat.js";
import logger from "@/utils/logger.js";

/**
 * Command handler function type
 * @param page - Playwright page instance
 * @param query - The extracted query text (input with command words stripped)
 * @param conversationId - The conversation ID where the command was triggered
 */
export type CommandHandler = (
  query: string,
  conversationId: string,
) => Promise<void>;

/**
 * Command definition with metadata and handler
 */
export interface CommandDefinition {
  name: string;
  actionType: "text" | "ignore" | "react" | "media";
  commandWords: string[];
  handler: CommandHandler;
}

/**
 * Predefined command handlers
 */
const commandHandlers = {
  async sendGif(query: string, conversationId: string) {
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
  async sendImage(query: string, conversationId: string) {
    console.log(`[Command:sendImage] Query: "${query}" in ${conversationId}`);
    // TODO: Implement image generation and send logic
  },
  async sendSticker(query: string, conversationId: string) {
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
  async sendVoiceNote(query: string, conversationId: string) {
    console.log(
      `[Command:sendVoiceNote] Query: "${query}" in ${conversationId}`,
    );
    // TODO: Implement voice note recording and send logic
  },
  async searchweb(query: string, conversationId: string) {
    console.log(`[Command:searchweb] Query: "${query}" in ${conversationId}`);
    // TODO: Implement search within conversation
  }
};

/**
 * Registry of all available commands
 */
export const COMMAND_REGISTRY: CommandDefinition[] = [
  {
    name: "send_gif",
    actionType: "media",
    commandWords: ["gif", "meme"],
    handler: commandHandlers.sendGif,
  },
  {
    name: "send_image",
    actionType: "media",
    commandWords: ["create", "pic", "picture", "generate"],
    handler: commandHandlers.sendImage,
  },
  {
    name: "send_sticker",
    actionType: "media",
    commandWords: ["sticker"],
    handler: commandHandlers.sendSticker,
  },
  {
    name: "send_voice_note",
    actionType: "media",
    commandWords: ["voice", "speak"],
    handler: commandHandlers.sendVoiceNote,
  },
  {
    name: "search_web",
    actionType: "text",
    commandWords: ["search", "find", "web"],
    handler: commandHandlers.searchweb,
  }
];

/**
 * Get command handler by name
 */
export function getCommandHandler(commandName: string): CommandHandler | null {
  const command = COMMAND_REGISTRY.find((cmd) => cmd.name === commandName);
  return command?.handler ?? null;
}

/**
 * Get all command names
 */
export function getAllCommandNames(): string[] {
  return COMMAND_REGISTRY.map((cmd) => cmd.name);
}
