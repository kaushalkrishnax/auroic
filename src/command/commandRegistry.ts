import {
  playMusic,
  sendGIF,
  sendSticker,
  sendVoiceNote,
} from "@/automation/chat.js";
import type { ActionContext } from "@/types/index.js";
import logger from "@/utils/logger.js";

/**
 * Command handler function type.
 */
export type CommandHandler = (context: ActionContext) => Promise<void>;

/**
 * Command definition with metadata and handler
 */
export interface CommandDefinition {
  name: string;
  handlerName: string;
  actionType: "text" | "ignore" | "react" | "media";
  description: string;
  commandWords: string[];
  handler: CommandHandler;
}

/**
 * Predefined command handlers
 */
const commandHandlers = {
  async sendGif(context: ActionContext) {
    const title = context.classifiedCommand!.query.trim() || "funny";
    const sent = await sendGIF(title, context.chatId, context.targetMessageId!);
    if (!sent) {
      throw new Error(`send_gif failed for query: ${title}`);
    }

    logger.info("Command handler sent GIF", {
      command: "send_gif",
      conversationId: context.chatId,
      query: title,
    });
  },

  async sendSticker(context: ActionContext) {
    const title = context.classifiedCommand!.query.trim() || "funny";
    const sent = await sendSticker(
      title,
      context.chatId,
      context.targetMessageId!,
    );
    if (!sent) {
      throw new Error(`send_sticker failed for query: ${title}`);
    }

    logger.info("Command handler sent sticker", {
      command: "send_sticker",
      conversationId: context.chatId,
      query: title,
    });
  },

  async sendVoiceNote(context: ActionContext) {
    const text = context.classifiedCommand!.query.trim();
    const sent = await sendVoiceNote(
      text,
      context.chatId,
      context.targetMessageId!,
    );
    if (!sent) {
      throw new Error(`send_voice_note failed for query: ${text}`);
    }

    logger.info("Command handler sent voice note", {
      command: "send_voice_note",
      conversationId: context.chatId,
      query: text,
    });
  },

  async playMusic(context: ActionContext) {
    const query = context.classifiedCommand!.query.trim();

    const sent = await playMusic(query);

    if (!sent) {
      throw new Error(`play_music failed for query: ${query}`);
    }

    logger.info("Command handler played music", {
      command: "play_music",
      conversationId: context.chatId,
      query,
    });
  },
};

/**
 * Registry of all available commands
 */
export const COMMAND_REGISTRY: CommandDefinition[] = [
  {
    name: "send_gif",
    handlerName: "sendGif",
    actionType: "media",
    description: "Send a GIF matching the query",
    commandWords: ["gif", "meme"],
    handler: commandHandlers.sendGif,
  },
  {
    name: "send_sticker",
    handlerName: "sendSticker",
    actionType: "media",
    description: "Send a sticker matching the query",
    commandWords: ["sticker"],
    handler: commandHandlers.sendSticker,
  },
  {
    name: "send_voice_note",
    handlerName: "sendVoiceNote",
    actionType: "media",
    description: "Record and send a voice note",
    commandWords: ["voice", "speak"],
    handler: commandHandlers.sendVoiceNote,
  },
  {
    name: "play_music",
    handlerName: "playMusic",
    actionType: "media",
    description: "Find and play a music track",
    commandWords: ["play", "music", "song"],
    handler: commandHandlers.playMusic,
  },
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
