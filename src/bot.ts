import {
  Client, GatewayIntentBits, Events, REST, Routes,
  SlashCommandBuilder, MessageFlags,
  type Message, type Interaction,
} from "discord.js";
import { ask } from "./agent.js";
import { Session } from "./session.js";
import { logger } from "./logger.js";
import { loadConfig } from "./config.js";
import { setDiscordClient } from "./tools/builtin/discord.js";
import { fixMarkdownLinks } from "./utils/format.js";

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("開始新對話（歸檔當前頻道的 session）")
    .toJSON(),
];

async function registerSlashCommands(token: string, clientId: string, guildIds: string[]): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: SLASH_COMMANDS });
      logger.info({ guildId, count: SLASH_COMMANDS.length }, "slash commands registered to guild");
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "slash command registration failed");
  }
}

function sessionIdForMessage(msg: Message): string {
  return msg.guild
    ? `discord-channel-${msg.channelId}`
    : `discord-dm-${msg.author.id}`;
}

export async function startBot(token: string): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  setDiscordClient(client);

  client.once(Events.ClientReady, async (c) => {
    logger.info({ user: c.user.tag }, "discord bot ready");
    console.log(`Discord bot logged in as ${c.user.tag}`);
    const guildIds = c.guilds.cache.map(g => g.id);
    await registerSlashCommands(token, c.user.id, guildIds);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "new") {
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;
      const session = new Session(sessionId);
      session.archive();
      logger.info({ sessionId }, "session archived via /new");

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const channelContext = `Current Discord channel ID: ${interaction.channelId}`;
      const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(5, 16).replace("-", "/");
      const newSessionContent = `<@${interaction.user.id}>(${interaction.user.username}) 使用 /new 開始了新對話。請根據 system prompt 中的人格設定和長期記憶，以你的身份打招呼。`;

      // 直接用結構化格式 append，不經過 ask 的 prompt 參數
      session.append({ role: "user", content: newSessionContent, time: ts });

      try {
        const response = await ask(null, { session, systemPrompt: channelContext });
        const text = response.text || "（新對話開始）";
        const formatted = fixMarkdownLinks(text);
        const chunks = chunkMessage(formatted, 2000);
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      } catch (err) {
        logger.error({ err: (err as Error).message }, "/new failed");
        await interaction.deleteReply().catch(() => {});
      }
    }
  });

  const config = loadConfig();

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // 所有訊息都 append 到 session（不論是否觸發 bot）
    const sessionId = sessionIdForMessage(message);
    const session = new Session(sessionId);
    const fmt = await formatIncomingMessage(message);
    session.append({ role: "user", content: fmt.content, time: fmt.time, msgId: fmt.msgId, ...(fmt.replyTo ? { replyTo: fmt.replyTo } : {}) });

    const isMentioned = client.user ? message.mentions.has(client.user) : false;
    const isDM = !message.guild;
    if (!isMentioned && !isDM) return;

    // DM 只回主人
    if (isDM && config.discord.owner_id && message.author.id !== config.discord.owner_id) {
      logger.info({ userId: message.author.id }, "DM from non-owner rejected");
      return;
    }
    // guild 白名單
    if (message.guild && config.discord.allowed_guilds.length > 0
        && !config.discord.allowed_guilds.includes(message.guild.id)) return;
    // channel 白名單
    if (!isDM && config.discord.allowed_channels.length > 0
        && !config.discord.allowed_channels.includes(message.channelId)) return;

    await handleTrigger(message, session);
  });

  await client.login(token);
}

interface FormattedMessage {
  content: string;
  time: string;
  msgId: string;
  replyTo?: string;
}

async function formatIncomingMessage(message: Message): Promise<FormattedMessage> {
  const authorName = message.member?.displayName ?? message.author.username;
  const authorId = message.author.id;
  const botId = message.client.user?.id ?? "";
  const botName = message.guild?.members.me?.displayName ?? message.client.user?.username ?? "bot";

  const normalizeMentions = async (text: string): Promise<string> => {
    const matches = [...text.matchAll(/<@!?(\d+)>/g)];
    if (matches.length === 0) return text;
    const nameMap = new Map<string, string>();
    for (const m of matches) {
      const id = m[1];
      if (nameMap.has(id)) continue;
      if (id === botId) { nameMap.set(id, botName); continue; }
      try {
        if (message.guild) {
          const member = await message.guild.members.fetch(id);
          nameMap.set(id, member.displayName);
        } else {
          const user = await message.client.users.fetch(id);
          nameMap.set(id, user.username);
        }
      } catch { nameMap.set(id, "unknown"); }
    }
    return text.replace(/<@!?(\d+)>/g, (orig, id) => `${orig}(${nameMap.get(id) ?? "unknown"})`);
  };

  const ts = new Date(message.createdTimestamp).toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(5, 16).replace("-", "/");
  const content = await normalizeMentions(message.content);
  const attach = message.attachments.size > 0
    ? ` [附件: ${[...message.attachments.values()].map(a => a.url).join(", ")}]`
    : "";

  return {
    content: `<@${authorId}>(${authorName}): ${content}${attach}`,
    time: ts,
    msgId: message.id,
    ...(message.reference?.messageId ? { replyTo: message.reference.messageId } : {}),
  };
}

async function handleTrigger(message: Message, session: Session): Promise<void> {
  logger.info({
    sessionId: session.id,
    author: message.author.tag,
    content: message.content.slice(0, 200),
  }, "discord trigger");

  if ("sendTyping" in message.channel) {
    await message.channel.sendTyping().catch(() => {});
  }

  try {
    const channelContext = `Current Discord channel ID: ${message.channelId}`;
    const response = await ask(null, { session, systemPrompt: channelContext });
    logger.info({
      sessionId: session.id,
      textLength: response.text?.length ?? 0,
      textPreview: response.text?.slice(0, 200) ?? "(empty)",
      toolsUsed: response.toolsUsed.map(t => t.tool),
    }, "discord agent response");

    if (!response.text) {
      await message.react("🤔").catch(() => {});
      return;
    }

    // 若 AI 輸出 <@id>(暱稱) 格式，清掉括號讓 Discord 正常渲染 mention
    const stripped = response.text.replace(/(<@!?\d+>)[\(（][^\)）]*[\)）]/g, "$1");
    const formatted = fixMarkdownLinks(stripped);
    const chunks = chunkMessage(formatted, 2000);
    const sentIds: string[] = [];
    for (const chunk of chunks) {
      const sent = await message.reply(chunk);
      sentIds.push(sent.id);
    }
    if (sentIds.length > 0) {
      session.setLastAssistantMsgId(sentIds.join(","));
    }
    logger.info({ sessionId: session.id, chunks: chunks.length, sentIds }, "discord reply sent");
  } catch (err) {
    logger.error({ err: (err as Error).message, stack: (err as Error).stack }, "discord handle trigger failed");
    await message.react("🤕").catch(() => {});
  }
}

function chunkMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let cutAt = remaining.lastIndexOf("\n", maxLength);
    if (cutAt < maxLength / 2) cutAt = maxLength;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
