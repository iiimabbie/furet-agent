import type { Client } from "discord.js";
import { logger } from "../../logger.js";
import type { Tool } from "../../types.js";
import { normalizeMentions } from "../../utils/discord-mentions.js";

let discordClient: Client | null = null;

export function setDiscordClient(client: Client): void {
  discordClient = client;
}

export function getDiscordClient(): Client | null {
  return discordClient;
}

function getClient(): Client {
  if (!discordClient) throw new Error("Discord client not initialized (bot not running)");
  return discordClient;
}

async function getTextChannel(channelId: string) {
  const channel = await getClient().channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("send" in channel))
    throw new Error(`channel ${channelId} not found or not text-based`);
  return channel;
}

export const discordFetchMessage: Tool = {
  name: "discord_fetch_message",
  description: "Fetch a Discord message by channel and message ID. Use this when you need to look up a message's content.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to fetch" },
    },
    required: ["channel_id", "message_id"],
  },
  execute: async (args) => {
    const { channel_id, message_id } = args as { channel_id: string; message_id: string };
    logger.info({ channel_id, message_id }, "discord_fetch_message");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      const authorName = msg.member?.displayName ?? msg.author.username;
      const content = await normalizeMentions(msg.content, getClient(), msg.guild);
      return JSON.stringify({
        messageId: msg.id,
        channelId: msg.channelId,
        author: { id: msg.author.id, name: authorName, isBot: msg.author.bot },
        content,
        timestamp: new Date(msg.createdTimestamp).toISOString(),
        editedTimestamp: msg.editedTimestamp ? new Date(msg.editedTimestamp).toISOString() : null,
        attachments: msg.attachments.map(a => a.url),
        replyToMessageId: msg.reference?.messageId,
      }, null, 2);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordSendMessage: Tool = {
  name: "discord_send_message",
  description: "Send a message to a Discord channel. Use this to proactively send messages, not as a reply.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      content: { type: "string", description: "The message content to send" },
      reply_to: { type: "string", description: "Optional message ID to reply to" },
    },
    required: ["channel_id", "content"],
  },
  execute: async (args) => {
    const { channel_id, content, reply_to } = args as { channel_id: string; content: string; reply_to?: string };
    logger.info({ channel_id, content: content.slice(0, 100), reply_to }, "discord_send_message");
    try {
      const channel = await getTextChannel(channel_id);
      const options = reply_to
        ? { content, reply: { messageReference: reply_to } }
        : { content };
      const sent = await channel.send(options);
      return `Message sent (msg:${sent.id})`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordReact: Tool = {
  name: "discord_react",
  description: "Add an emoji reaction to a Discord message.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to react to" },
      emoji: { type: "string", description: "The emoji to react with (e.g. '👍', '❤️', or custom emoji name)" },
    },
    required: ["channel_id", "message_id", "emoji"],
  },
  execute: async (args) => {
    const { channel_id, message_id, emoji } = args as { channel_id: string; message_id: string; emoji: string };
    logger.info({ channel_id, message_id, emoji }, "discord_react");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      await msg.react(emoji);
      return `Reacted with ${emoji}`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordPin: Tool = {
  name: "discord_pin",
  description: "Pin a message in a Discord channel.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to pin" },
    },
    required: ["channel_id", "message_id"],
  },
  execute: async (args) => {
    const { channel_id, message_id } = args as { channel_id: string; message_id: string };
    logger.info({ channel_id, message_id }, "discord_pin");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      await msg.pin();
      return `Message pinned`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordUnpin: Tool = {
  name: "discord_unpin",
  description: "Unpin a message in a Discord channel.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to unpin" },
    },
    required: ["channel_id", "message_id"],
  },
  execute: async (args) => {
    const { channel_id, message_id } = args as { channel_id: string; message_id: string };
    logger.info({ channel_id, message_id }, "discord_unpin");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      await msg.unpin();
      return `Message unpinned`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordCreateThread: Tool = {
  name: "discord_create_thread",
  description: "Create a thread from a message in a Discord channel.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to create a thread from" },
      name: { type: "string", description: "The thread name" },
    },
    required: ["channel_id", "message_id", "name"],
  },
  execute: async (args) => {
    const { channel_id, message_id, name } = args as { channel_id: string; message_id: string; name: string };
    logger.info({ channel_id, message_id, name }, "discord_create_thread");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      if (!("startThread" in msg)) return "Error: cannot create thread from this message";
      const thread = await msg.startThread({ name });
      return `Thread created: ${thread.name} (${thread.id})`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordCreateForumPost: Tool = {
  name: "discord_create_forum_post",
  description: "Create a new post (thread) in a Discord forum channel.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The forum channel ID" },
      title: { type: "string", description: "The post title" },
      content: { type: "string", description: "The initial message content of the post" },
    },
    required: ["channel_id", "title", "content"],
  },
  execute: async (args) => {
    const { channel_id, title, content } = args as { channel_id: string; title: string; content: string };
    logger.info({ channel_id, title }, "discord_create_forum_post");
    try {
      const channel = await getClient().channels.fetch(channel_id);
      if (!channel || !("threads" in channel)) return `Error: channel ${channel_id} is not a forum channel`;
      const thread = await (channel as import("discord.js").ForumChannel).threads.create({
        name: title,
        message: { content },
      });
      return `Forum post created: "${thread.name}" (thread:${thread.id})`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordDeleteThread: Tool = {
  name: "discord_delete_thread",
  description: "Delete a thread in a Discord channel.",
  parameters: {
    type: "object",
    properties: {
      thread_id: { type: "string", description: "The thread ID to delete" },
    },
    required: ["thread_id"],
  },
  execute: async (args) => {
    const { thread_id } = args as { thread_id: string };
    logger.info({ thread_id }, "discord_delete_thread");
    try {
      const channel = await getClient().channels.fetch(thread_id);
      if (!channel || !channel.isThread()) return `Error: ${thread_id} is not a thread`;
      await channel.delete();
      return `Thread deleted`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordEditMessage: Tool = {
  name: "discord_edit_message",
  description: "Edit one of the bot's own messages.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to edit (must be the bot's own message)" },
      content: { type: "string", description: "The new message content" },
    },
    required: ["channel_id", "message_id", "content"],
  },
  execute: async (args) => {
    const { channel_id, message_id, content } = args as { channel_id: string; message_id: string; content: string };
    logger.info({ channel_id, message_id, content: content.slice(0, 100) }, "discord_edit_message");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      if (msg.author.id !== getClient().user?.id) return "Error: can only edit own messages";
      await msg.edit(content);
      return `Message edited`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordDeleteMessage: Tool = {
  name: "discord_delete_message",
  description: "Delete one of the bot's own messages.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      message_id: { type: "string", description: "The message ID to delete (must be the bot's own message)" },
    },
    required: ["channel_id", "message_id"],
  },
  execute: async (args) => {
    const { channel_id, message_id } = args as { channel_id: string; message_id: string };
    logger.info({ channel_id, message_id }, "discord_delete_message");
    try {
      const channel = await getTextChannel(channel_id);
      const msg = await channel.messages.fetch(message_id);
      if (msg.author.id !== getClient().user?.id) return "Error: can only delete own messages";
      await msg.delete();
      return `Message deleted`;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const discordFetchChannelMessages: Tool = {
  name: "discord_fetch_channel_messages",
  description: "Fetch recent messages from a Discord channel. Returns up to `limit` messages (default 20, max 100), always ordered newest-first regardless of before/after mode. Optionally fetch messages before or after a given message ID for pagination.",
  parameters: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID" },
      limit: { type: "number", description: "Number of messages to fetch (default 20, max 100)" },
      before: { type: "string", description: "Fetch messages before this message ID (for pagination)" },
      after: { type: "string", description: "Fetch messages after this message ID" },
    },
    required: ["channel_id"],
  },
  execute: async (args) => {
    const { channel_id, limit = 20, before, after } = args as {
      channel_id: string;
      limit?: number;
      before?: string;
      after?: string;
    };
    logger.info({ channel_id, limit, before, after }, "discord_fetch_channel_messages");
    try {
      const channel = await getTextChannel(channel_id);
      const fetchOptions: { limit: number; before?: string; after?: string } = {
        limit: Math.min(Math.max(1, limit), 100),
      };
      if (before) fetchOptions.before = before;
      if (after) fetchOptions.after = after;
      const messages = await channel.messages.fetch(fetchOptions);
      const client = getClient();
      // 統一 newest-first：after 模式 Discord API 回傳是舊到新，在這裡強制排序
      const sorted = Array.from(messages.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      const result = await Promise.all(sorted.map(async msg => {
        const authorName = msg.member?.displayName ?? msg.author.username;
        const content = await normalizeMentions(msg.content, client, msg.guild);
        return {
          messageId: msg.id,
          author: { id: msg.author.id, name: authorName, isBot: msg.author.bot },
          content,
          timestamp: new Date(msg.createdTimestamp).toISOString(),
          editedTimestamp: msg.editedTimestamp ? new Date(msg.editedTimestamp).toISOString() : null,
          replyToMessageId: msg.reference?.messageId ?? null,
          attachments: msg.attachments.map(a => a.url),
        };
      }));
      return JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};
