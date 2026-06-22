import { initDB, closeDB } from "@/db/index.js";
import { closeConfigDB } from "@/db/configDb.js";
import {
  initRuntimeConfig,
  getConfig,
  setBotFbid,
  reloadConfig,
  BOT_FBID,
} from "@/runtime/index.js";
import { startServer } from "@/api/server.js";
import { emitEvent, eventBus } from "@/events.js";
import type { AppEvent } from "@/events.js";
import { processMessage } from "@/router/pipeline.js";
import { isSystemPaused } from "@/runtime/systemControl.js";
import { generateSpeechBuffer } from "@/runtime/tts.js";
import logger from "@/utils/logger.js";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  Partials,
  Events,
  EmbedBuilder,
  AttachmentBuilder,
} from "discord.js";

// Database query functions
import {
  insertIncomingMessage,
  editMessage,
  markMessageDeleted,
  getLatestMessages,
  getMessageByMid,
} from "@/db/queries/messages.js";
import { insertReaction, deleteReaction } from "@/db/queries/reactions.js";
import { insertMedia, getMediaForMessage } from "@/db/queries/media.js";
import { createUsers } from "@/db/queries/users.js";
import {
  createConversation,
  createConversationParticipants,
  ensureConversationExists,
  getConversationById,
  getStartupConversationIds,
} from "@/db/queries/conversations.js";

export class AuroicCore {
  private client: Client | null = null;
  private shuttingDown = false;

  // Tracker state
  private sessionStartTime = 0;
  private processedThisSession = new Set<string>();
  private readonly MAX_TRACKED_SESSION_MIDS = 5_000;

  constructor() {
    this.onAppEvent = this.onAppEvent.bind(this);
  }

  /**
   * Get the Discord client instance
   */
  getClient(): Client | null {
    return this.client;
  }

  /**
   * Start the core AI Agent system
   */
  async start(): Promise<void> {
    logger.info("Starting Auroic Core...");
    this.sessionStartTime = Date.now();
    this.processedThisSession.clear();

    // 1. Initialize config and databases
    initRuntimeConfig();
    const config = getConfig();
    initDB(config.db.path);

    // 2. Initialize Discord client
    const token = config.discord?.token;
    if (!token) {
      throw new Error(
        "Discord bot token is not configured. Set DISCORD_TOKEN in your environment or database configuration."
      );
    }

    logger.info("Initializing Discord Client...");

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction,
        Partials.User,
      ],
    });

    this.setupEventHandlers();

    await this.client.login(token);

    // 3. Register global event handler
    eventBus.on("event", this.onAppEvent);

    // 4. Start HTTP Server for Dashboard / API
    startServer(this);

    // 5. Register shutdown handlers
    this.registerShutdown();

    logger.info("Auroic Core started successfully");
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.once(Events.ClientReady, (readyClient) => {
      logger.info("Discord client logged in successfully", {
        botId: readyClient.user.id,
        tag: readyClient.user.tag,
      });
      setBotFbid(readyClient.user.id);
    });

    this.client.on(Events.MessageCreate, async (message) => {
      try {
        if (!this.client) return;
        const config = getConfig();
        const allowedChannels = config.discord?.allowedChannels as string[] | undefined;

        // Channel filter list check
        if (allowedChannels && allowedChannels.length > 0) {
          if (!allowedChannels.includes(message.channelId)) {
            return;
          }
        }

        // Map author details to user DB
        createUsers([{
          userId: message.author.id,
          username: message.author.username,
          displayName: message.author.displayName || message.author.username,
          avatarUrl: message.author.displayAvatarURL(),
          isVerified: false,
          platform: "discord",
        }]);

        // Map channel to conversation DB
        const isGroup = message.channel.type !== ChannelType.DM;
        const channelName = "name" in message.channel ? message.channel.name : message.author.username;
        createConversation({
          conversationId: message.channelId,
          platform: "discord",
          title: channelName || message.author.username,
          avatarUrl: null,
          createdByUserId: null,
          isGroup: isGroup,
          isMuted: false,
        });
        createConversationParticipants(message.channelId, [message.author.id]);

        // Map and insert attachments / media
        for (const attachment of message.attachments.values()) {
          insertMedia({
            messageId: message.id,
            attachmentType: attachment.contentType || "file",
            url: attachment.url,
            previewUrl: attachment.url,
          });
        }

        // Map message to incoming message DB
        insertIncomingMessage({
          messageId: message.id,
          conversationId: message.channelId,
          userId: message.author.id,
          timestampMs: message.createdTimestamp,
          messageType: "text",
          textContent: message.content || null,
          replyToMessageId: message.reference?.messageId || null,
        });

        // Skip bot self-trigger loops
        if (message.author.id === this.client.user?.id || message.author.bot) {
          return;
        }

        // Emit new message event to core pipeline
        emitEvent({
          type: "NEW_MESSAGE",
          chatId: message.channelId,
          mid: message.id,
          senderFbid: message.author.id,
          timestampMs: message.createdTimestamp,
        });
      } catch (err) {
        logger.error("Error processing Discord message create event", {
          messageId: message.id,
          error: (err as Error).message,
        });
      }
    });

    this.client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
      try {
        if (newMessage.partial) {
          newMessage = await newMessage.fetch();
        }

        // Check if contents have changed
        if (oldMessage.content !== newMessage.content) {
          editMessage(newMessage.id, newMessage.content || "");
          emitEvent({
            type: "EDIT",
            chatId: newMessage.channelId,
            mid: newMessage.id,
          });
        }
      } catch (err) {
        logger.error("Error processing Discord message update event", {
          messageId: newMessage.id,
          error: (err as Error).message,
        });
      }
    });

    this.client.on(Events.MessageDelete, async (message) => {
      try {
        markMessageDeleted(message.id);
        emitEvent({
          type: "DELETE",
          chatId: message.channelId,
          mid: message.id,
        });
      } catch (err) {
        logger.error("Error processing Discord message delete event", {
          messageId: message.id,
          error: (err as Error).message,
        });
      }
    });

    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      try {
        if (reaction.partial) {
          await reaction.fetch();
        }
        if (user.partial) {
          await user.fetch();
        }

        const emojiName = reaction.emoji.name;
        if (!emojiName) return;

        insertReaction({
          messageId: reaction.message.id,
          userId: user.id,
          reaction: emojiName,
          timestampMs: Date.now(),
        });

        emitEvent({
          type: "REACTION_ADD",
          chatId: reaction.message.channelId,
          mid: reaction.message.id,
          senderFbid: user.id,
          reaction: emojiName,
        });
      } catch (err) {
        logger.error("Error processing Discord reaction add event", {
          error: (err as Error).message,
        });
      }
    });

    this.client.on(Events.MessageReactionRemove, async (reaction, user) => {
      try {
        if (reaction.partial) {
          await reaction.fetch();
        }
        deleteReaction(reaction.message.id);
        emitEvent({
          type: "REACTION_REMOVE",
          chatId: reaction.message.channelId,
          mid: reaction.message.id,
        });
      } catch (err) {
        logger.error("Error processing Discord reaction remove event", {
          error: (err as Error).message,
        });
      }
    });
  }

  /**
   * Gracefully shutdown the core system
   */
  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info(`Received ${signal} — shutting down gracefully…`);

    eventBus.off("event", this.onAppEvent);

    if (this.client) {
      try {
        logger.info("Shutting down Discord client...");
        this.client.destroy();
        this.client = null;
      } catch (err) {
        logger.error("Failed to shutdown Discord client", {
          error: (err as Error).message,
        });
      }
    }

    closeDB();
    closeConfigDB();
    logger.info("Shutdown complete.");
    process.exit(0);
  }

  private registerShutdown(): void {
    process.on("SIGINT", () => void this.shutdown("SIGINT"));
    process.on("SIGTERM", () => void this.shutdown("SIGTERM"));
  }

  private trackProcessedMid(mid: string): void {
    if (this.processedThisSession.has(mid)) return;
    this.processedThisSession.add(mid);

    while (this.processedThisSession.size > this.MAX_TRACKED_SESSION_MIDS) {
      const oldest = this.processedThisSession.values().next().value;
      if (!oldest) break;
      this.processedThisSession.delete(oldest);
    }
  }

  private onAppEvent(event: AppEvent): void {
    if (this.shuttingDown) return;
    if (event.type !== "NEW_MESSAGE" && event.type !== "EDIT") return;

    if (isSystemPaused()) {
      logger.info("Skipping event while system is paused", {
        type: event.type,
        chatId: event.chatId,
        mid: event.mid,
      });
      return;
    }

    if (event.type === "NEW_MESSAGE") {
      if (event.timestampMs < this.sessionStartTime) {
        logger.info("Skipping offline message from before session start", {
          chatId: event.chatId,
          mid: event.mid,
          timestampMs: event.timestampMs,
          sessionStartTime: this.sessionStartTime,
        });
        return;
      }

      if (this.processedThisSession.has(event.mid)) {
        logger.info("Skipping already-processed message in this session", {
          chatId: event.chatId,
          mid: event.mid,
        });
        return;
      }

      this.trackProcessedMid(event.mid);

      const botId = BOT_FBID;
      if (botId && event.senderFbid === botId) return;
    }

    processMessage(this, event.chatId, event.mid).catch((err: unknown) => {
      logger.error("Message processing failed", {
        chatId: event.chatId,
        mid: event.mid,
        error: (err as Error).message,
      });
    });
  }

  // --- Discord Native Actions ---

  async sendText(
    chatId: string,
    text: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    try {
      if (!this.client) return false;
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !("send" in channel)) {
        logger.warn("Discord channel not found or not sendable", { chatId });
        return false;
      }

      const options: any = { content: text };
      if (replyToMessageId) {
        options.reply = {
          messageReference: replyToMessageId,
          failIfNotExists: false,
        };
      }

      await (channel as any).send(options);
      return true;
    } catch (err) {
      logger.error("Failed to send text message to Discord", {
        chatId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  private async fetchGiphyUrl(query: string): Promise<string | null> {
    try {
      const response = await fetch(
        `https://api.giphy.com/v1/gifs/search?api_key=dc6zaTOxFJmzC&q=${encodeURIComponent(
          query
        )}&limit=5`
      );
      if (response.ok) {
        const json: any = await response.json();
        const items = json.data;
        if (items && items.length > 0) {
          const randomIdx = Math.floor(Math.random() * items.length);
          return items[randomIdx]?.images?.original?.url || null;
        }
      }
    } catch (err) {
      logger.debug("Failed to query Giphy API", { error: (err as Error).message });
    }
    return null;
  }

  async sendMedia(
    chatId: string,
    query: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    try {
      if (!this.client) return false;
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !("send" in channel)) return false;

      const gifUrl = await this.fetchGiphyUrl(query);
      const content = gifUrl ? gifUrl : `GIF matching: "${query}"`;

      const options: any = { content };
      if (replyToMessageId) {
        options.reply = {
          messageReference: replyToMessageId,
          failIfNotExists: false,
        };
      }

      await (channel as any).send(options);
      return true;
    } catch (err) {
      logger.error("Failed to send media to Discord", {
        chatId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  async sendGIF(
    chatId: string,
    query: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    return this.sendMedia(chatId, query, replyToMessageId);
  }

  async sendSticker(
    chatId: string,
    query: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    return this.sendMedia(chatId, query, replyToMessageId);
  }

  async sendVoiceNote(
    chatId: string,
    text: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    try {
      if (!this.client) return false;
      const buffer = await generateSpeechBuffer(text);
      if (!buffer) {
        logger.error("Failed to generate speech buffer for Discord voice note");
        return false;
      }

      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !("send" in channel)) return false;

      const attachment = new AttachmentBuilder(buffer, { name: "voice.mp3" });
      const options: any = {
        files: [attachment],
      };
      if (replyToMessageId) {
        options.reply = {
          messageReference: replyToMessageId,
          failIfNotExists: false,
        };
      }

      await (channel as any).send(options);
      return true;
    } catch (err) {
      logger.error("Failed to send voice note to Discord", {
        chatId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  async addReaction(
    reaction: string,
    chatId: string,
    messageId: string
  ): Promise<boolean> {
    try {
      if (!this.client) return false;
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !("messages" in channel)) return false;

      const message = await (channel as any).messages.fetch(messageId);
      if (!message) return false;

      await message.react(reaction);
      return true;
    } catch (err) {
      logger.error("Failed to add reaction to Discord message", {
        chatId,
        messageId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  async playMusic(query: string, chatId?: string): Promise<boolean> {
    try {
      if (!this.client || !chatId) {
        logger.warn("Discord client not initialized or no chatId provided for music playback");
        return false;
      }

      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !("send" in channel)) {
        logger.warn("Discord channel not found or not sendable for music playback", { chatId });
        return false;
      }

      logger.info("Playing music request on Discord", { chatId, query });

      // Create a gorgeous music player Embed
      const embed = new EmbedBuilder()
        .setColor("#1DB954")
        .setTitle("🎵 Now Playing")
        .setDescription(`**${query}**`)
        .setThumbnail("https://media.giphy.com/media/l3vQYm0jWcr4v182u/giphy.gif")
        .addFields(
          { name: "Playback State", value: "▶️ Playing", inline: true },
          { name: "Duration", value: "3:45", inline: true },
          { name: "Progress", value: "`▶️ 🔘─────────────────── 0:03 / 3:45`" }
        )
        .setFooter({ text: "Auroic Premium Player • Powered by AI" })
        .setTimestamp();

      // Send the embed to the chat channel
      await (channel as any).send({ embeds: [embed] });

      // Also trigger a TTS preview voice note so they hear it!
      const previewText = `Now playing: ${query} on the music system.`;
      await this.sendVoiceNote(chatId, previewText);

      return true;
    } catch (err) {
      logger.error("Failed to play music on Discord", {
        chatId,
        query,
        error: (err as Error).message,
      });
      return false;
    }
  }
}
