import {
  Client, GatewayIntentBits, Events, REST, Routes,
  SlashCommandBuilder, MessageFlags, EmbedBuilder, ActivityType, PresenceStatusData,
  type Message, type Interaction,
} from "discord.js";
import { spawn } from "node:child_process";
import { ask } from "./agent.js";
import { Session } from "./session.js";
import { SESSION_SUMMARIZE_PROMPT } from "./prompt.js";
import { logger } from "./logger.js";
import { loadConfig, setCurrentModel } from "./config.js";
import { setDiscordClient } from "./tools/builtin/discord.js";
import { clearAttachments, drainAttachments } from "./tools/context.js";
import { fixMarkdownLinks } from "./utils/format.js";
import { normalizeMentions } from "./utils/discord-mentions.js";

import { loadCrons } from "./tools/builtin/cron.js";
import { getAuthClient, getAuthUrl, exchangeCode } from "./google/auth.js";
import { google } from "googleapis";
import { loadReminders } from "./tools/builtin/reminder.js";
import type { TokenUsage, ProgressEvent } from "./types.js";

// model pricing (USD per million tokens) — from Anthropic official pricing
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5-20251101": { input: 5, output: 25 },
  "claude-opus-4-1-20250805": { input: 15, output: 75 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-sonnet-3-7-20250219": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
};

function estimateCost(usage: TokenUsage, model: string): string {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return "unknown";
  const cost = (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) / 1_000_000;
  return `$${cost.toFixed(4)}`;
}

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("開始新對話（歸檔當前頻道的 session）")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("查看 bot 狀態")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("重啟整個 furet gateway（owner only）")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("切換 AI 模型（owner only）")
    .addStringOption(opt =>
      opt.setName("name").setDescription("模型名稱").setRequired(true).setAutocomplete(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("google-auth")
    .setDescription("Google OAuth 授權（owner only）")
    .addStringOption(opt =>
      opt.setName("callback").setDescription("授權後的 redirect 網址").setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("task")
    .setDescription("列出 Google Tasks 待辦事項")
    .toJSON(),
];

/** Spawn 一個獨立的子進程跑同樣的 cmdline，自己退出。靠 detached + stdio:ignore 脫離父進程。 */
function selfRestart(): void {
  // process.execArgv 帶上原本 node 啟動時的 flags（例如 tsx 的 --require / --import）；
  // 少了它們，新 node 不認識 .ts 檔就會直接死。
  const args = [...process.execArgv, ...process.argv.slice(1)];
  logger.info({ node: process.argv[0], execArgv: process.execArgv, argv: process.argv }, "self-restart spawning detached child");
  const child = spawn(process.argv[0], args, {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: process.env,
  });
  child.on("error", (err) => {
    logger.error({ err: err.message }, "self-restart spawn error");
  });
  child.unref();
  // 給子進程一點時間建立起來，再讓父進程退出
  setTimeout(() => {
    logger.info("self-restart parent exiting");
    process.exit(0);
  }, 500);
}

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

    const config = loadConfig();
    c.user.setPresence({
      status: (config.discord.status || "online") as PresenceStatusData,
      activities: [{ name: config.discord.activity || "Burrowing around", type: ActivityType.Custom }],
    });

    const guildIds = c.guilds.cache.map(g => g.id);
    await registerSlashCommands(token, c.user.id, guildIds);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // autocomplete for /model
    if (interaction.isAutocomplete() && interaction.commandName === "model") {
      const focused = interaction.options.getFocused();
      const { llm } = loadConfig();
      const filtered = llm.modelList
        .filter(m => m.includes(focused))
        .slice(0, 25);
      await interaction.respond(filtered.map(m => ({ name: m, value: m })));
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "new") {
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;
      const session = new Session(sessionId);

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channelContext = `Current Discord context: channel (ID: ${interaction.channelId}), session: ${sessionId}`;
      const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(5, 16).replace("-", "/");

      // 歸檔前：silent memory flush — 讓 agent 自由整理記憶
      if (session.length > 0) {
        const flushContext = `${channelContext}\n\n[System] ${SESSION_SUMMARIZE_PROMPT}`;
        session.append({ role: "user", content: "[System] Session ending — flush memory now.", time: ts });
        await ask(null, { session, systemPrompt: flushContext, trigger: "discord-owner" }).catch(err =>
          logger.error({ err: (err as Error).message }, "memory flush before /new failed")
        );
      }

      session.archive();
      logger.info({ sessionId }, "session archived via /new");

      const newSessionContent = `[System] <@${interaction.user.id}>(${interaction.user.username}) started a new session via /new. Greet them in character. All context (persona, memory, people) is already in the system prompt — do NOT read any files.`;
      session.append({ role: "user", content: newSessionContent, time: ts });

      try {
        const response = await ask(null, { session, systemPrompt: channelContext, trigger: "discord-owner" });
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

    if (interaction.commandName === "status") {
      const config = loadConfig();
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;
      const session = new Session(sessionId);
      const usage = session.getUsage();
      const crons = loadCrons();
      const reminders = loadReminders();
      const activeSessions = Session.listActive();
      const skills = config.skills;

      const totalTokens = usage.inputTokens + usage.outputTokens;
      const cost = estimateCost(usage, config.llm.currentModel);

      const embed = new EmbedBuilder()
        .setTitle("Furet Status")
        .addFields(
          { name: "Model", value: `\`${config.llm.currentModel}\``, inline: true },
          { name: "Cost", value: cost, inline: true },
          { name: "Tokens", value: `${totalTokens.toLocaleString()} (in: ${usage.inputTokens.toLocaleString()} / out: ${usage.outputTokens.toLocaleString()})`, inline: false },
          { name: "Active Sessions", value: `${activeSessions.length}`, inline: true },
          { name: "Crons", value: `${crons.filter(c => c.enabled).length} active / ${crons.length} total`, inline: true },
          { name: "Reminders", value: `${reminders.length} pending`, inline: true },
          { name: "Skills", value: skills.length > 0 ? skills.join(", ") : "none", inline: true },
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "restart") {
      const config = loadConfig();
      if (config.discord.owner_id && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply({ content: "只有主人能用這個指令！", flags: MessageFlags.Ephemeral });
        return;
      }
      logger.info({ user: interaction.user.id }, "/restart triggered");
      await interaction.reply({ content: "重啟中... 等個幾秒就回來。", flags: MessageFlags.Ephemeral });
      selfRestart();
    }

    if (interaction.commandName === "model") {
      const config = loadConfig();
      if (config.discord.owner_id && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply({ content: "只有主人能用這個指令！", flags: MessageFlags.Ephemeral });
        return;
      }
      const name = interaction.options.getString("name", true);
      if (config.llm.modelList.length > 0 && !config.llm.modelList.includes(name)) {
        await interaction.reply({ content: `不在 modelList 裡：\`${name}\``, flags: MessageFlags.Ephemeral });
        return;
      }
      const prev = config.llm.currentModel;
      setCurrentModel(name);
      logger.info({ prev, next: name, user: interaction.user.id }, "/model switched");
      await interaction.reply({ content: `模型已切換：\`${prev}\` → \`${name}\``, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "google-auth") {
      const config = loadConfig();
      if (config.discord.owner_id && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply({ content: "只有主人能用這個指令！", flags: MessageFlags.Ephemeral });
        return;
      }
      const callback = interaction.options.getString("callback");
      if (!callback) {
        const authed = getAuthClient();
        if (authed) {
          await interaction.reply({ content: "Google API 已經授權過了。", flags: MessageFlags.Ephemeral });
          return;
        }
        const url = getAuthUrl();
        if (!url) {
          await interaction.reply({ content: "請先在 .env 設定 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET 後重啟。", flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({
          content: `點這個連結授權：\n${url}\n\n授權後瀏覽器會跳到 \`http://localhost?code=xxx\`，把整個網址貼回來：\n\`/google-auth callback:<貼上整個網址>\``,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        try {
          await exchangeCode(callback);
          await interaction.reply({ content: "Google API 授權成功！", flags: MessageFlags.Ephemeral });
          logger.info({ user: interaction.user.id }, "google oauth completed via /google-auth");
        } catch (err) {
          await interaction.reply({ content: `授權失敗：${(err as Error).message}`, flags: MessageFlags.Ephemeral });
        }
      }
    }

    if (interaction.commandName === "task") {
      const auth = getAuthClient();
      if (!auth) {
        await interaction.reply({ content: "Google API 未授權，請先用 /google-auth 授權。", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const tasks = google.tasks({ version: "v1", auth });
        const res = await tasks.tasks.list({
          tasklist: "@default",
          maxResults: 20,
          showCompleted: false,
          showHidden: false,
        });
        const items = res.data.items || [];
        if (items.length === 0) {
          await interaction.editReply("沒有待辦事項 🎉");
          return;
        }
        const lines = items.map(t => {
          const due = t.due ? ` (${t.due.split("T")[0]})` : "";
          return `• ${t.title}${due}`;
        });
        const embed = new EmbedBuilder()
          .setTitle("Google Tasks")
          .setDescription(lines.join("\n"))
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply(`取得 Tasks 失敗：${(err as Error).message}`);
      }
    }
  });

  const config = loadConfig();

  client.on(Events.MessageCreate, async (message) => {
    // 自己的訊息不處理；其他 bot 的訊息只記錄不觸發
    if (message.author.id === client.user?.id) return;

    const sessionId = sessionIdForMessage(message);
    const isMentioned = client.user ? message.mentions.has(client.user) : false;
    const isDM = !message.guild;
    const isTrigger = !message.author.bot && (isMentioned || isDM);

    // Session 隔離：未被觸發且尚未有 session → 不偷看、不記錄
    // （只有 bot 被 @mention / reply / DM 後才會開啟這個 channel 的 session；
    //   之後該 channel 的所有訊息才會納入記錄，作為 reply chain 的上下文）
    if (!isTrigger && !Session.exists(sessionId)) return;

    const session = new Session(sessionId);

    // Thread/論壇貼文的第一次進入：抓初始訊息作為 context
    if (session.length === 0 && message.channel.isThread()) {
      try {
        const starter = await message.channel.fetchStarterMessage();
        if (starter) {
          const ts = new Date(starter.createdTimestamp).toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(5, 16).replace("-", "/");
          const authorName = starter.member?.displayName ?? starter.author.username;
          const threadName = message.channel.name;
          session.append({
            role: "user",
            content: `[System] This is the initial message of forum post "${threadName}" (by ${authorName}):\n${starter.content}`,
            time: ts,
            msgId: starter.id,
          });
        }
      } catch { /* starter message not available */ }
    }

    const fmt = await formatIncomingMessage(message);
    session.append({ role: "user", content: fmt.content, time: fmt.time, msgId: fmt.msgId, ...(fmt.replyTo ? { replyTo: fmt.replyTo } : {}) });

    if (!isTrigger) return;

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

    await handleTrigger(message, session, fmt.images);
  });

  await client.login(token);
}

interface FormattedMessage {
  content: string;
  time: string;
  msgId: string;
  replyTo?: string;
  images?: string[];
}

async function formatIncomingMessage(message: Message): Promise<FormattedMessage> {
  const authorName = message.member?.displayName ?? message.author.username;
  const authorId = message.author.id;

  const ts = new Date(message.createdTimestamp).toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(5, 16).replace("-", "/");
  const content = await normalizeMentions(message.content, message.client, message.guild);
  const attach = message.attachments.size > 0
    ? ` [附件: ${[...message.attachments.values()].map(a => a.url).join(", ")}]`
    : "";

  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
  const isImage = (a: { contentType?: string | null; name?: string | null }) =>
    a.contentType?.startsWith("image/") || imageExts.some(e => a.name?.toLowerCase().endsWith(e));

  const images = [...message.attachments.values()].filter(isImage).map(a => a.url);

  // reply 的訊息如果有圖片，也加進來
  if (message.reference?.messageId) {
    try {
      const replied = await message.channel.messages.fetch(message.reference.messageId);
      const replyImages = [...replied.attachments.values()].filter(isImage).map(a => a.url);
      images.push(...replyImages);
    } catch { /* replied message not available */ }
  }

  return {
    content: `<@${authorId}>(${authorName}): ${content}${attach}`,
    time: ts,
    msgId: message.id,
    ...(message.reference?.messageId ? { replyTo: message.reference.messageId } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

// --- Progress message editing ---

const PROGRESS_DEBOUNCE_MS = 1000;

interface ProgressLine {
  id: string;
  label: string;
  status: "running" | "ok" | "err";
}

function renderProgress(lines: ProgressLine[]): string {
  if (lines.length === 0) return "...";
  return lines
    .map(l => {
      const icon = l.status === "running" ? "→" : l.status === "ok" ? "✓" : "✗";
      return `${icon} ${l.label}`;
    })
    .join("\n");
}

async function handleTrigger(message: Message, session: Session, images?: string[]): Promise<void> {
  clearAttachments();
  logger.info({
    sessionId: session.id,
    author: message.author.tag,
    content: message.content.slice(0, 200),
  }, "discord trigger");

  const channel = message.channel;

  // 持續 typing indicator
  const typingInterval = setInterval(() => {
    if ("sendTyping" in channel) {
      (channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
    }
  }, 8000);
  if ("sendTyping" in channel) {
    await (channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
  }

  // 進度訊息狀態
  let progressMsg: Message | undefined;
  const progressLines: ProgressLine[] = [];
  let lastEditAt = 0;
  let flushChain: Promise<void> = Promise.resolve();

  const flushProgress = async () => {
    const now = Date.now();
    if (now - lastEditAt < PROGRESS_DEBOUNCE_MS) return;
    lastEditAt = now;
    const body = renderProgress(progressLines);
    try {
      if (!progressMsg) {
        progressMsg = await message.reply(body);
      } else {
        await progressMsg.edit(body);
      }
    } catch {
      // 編輯失敗不影響，最終回覆才是權威
    }
  };

  const onProgress = (event: ProgressEvent) => {
    if (event.type === "tool_start") {
      progressLines.push({ id: event.toolCallId, label: event.toolName, status: "running" });
    } else {
      const line = progressLines.find(l => l.id === event.toolCallId);
      if (line) line.status = event.isError ? "err" : "ok";
    }
    flushChain = flushChain.then(() => flushProgress());
  };

  try {
    const ch = channel;
    const channelType = ch.isThread()
      ? (ch.parent && "type" in ch.parent && ch.parent.type === 15 ? "forum post" : "thread")
      : (ch.isDMBased() ? "DM" : "channel");
    const parentInfo = ch.isThread() && ch.parentId ? `, parent channel: ${ch.parentId}` : "";
    const threadName = ch.isThread() ? `, name: "${ch.name}"` : "";
    const channelContext = `Current Discord context: ${channelType} (ID: ${message.channelId}${parentInfo}${threadName}), session: ${session.id}`;
    const isOwner = message.author.id === loadConfig().discord.owner_id;
    const response = await ask(null, { session, systemPrompt: channelContext, images, onProgress, trigger: isOwner ? "discord-owner" : "discord-other" });
    await flushChain; // 確保進度訊息已發送完成
    logger.info({
      sessionId: session.id,
      textLength: response.text?.length ?? 0,
      textPreview: response.text?.slice(0, 200) ?? "(empty)",
      toolsUsed: response.toolsUsed.map(t => t.tool),
    }, "discord agent response");

    if (!response.text) {
      // 沒有文字回覆：刪掉進度訊息，加 emoji
      if (progressMsg) await progressMsg.delete().catch(() => {});
      await message.react("🤔").catch(() => {});
      return;
    }

    // 若 AI 輸出 <@id>(暱稱) 格式，清掉括號讓 Discord 正常渲染 mention
    const stripped = response.text.replace(/(<@!?\d+>)[\(（][^\)）]*[\)）]/g, "$1");
    const formatted = fixMarkdownLinks(stripped);
    const chunks = chunkMessage(formatted, 2000);
    const sentIds: string[] = [];
    const attachments = drainAttachments();

    // 第一個 chunk：編輯進度訊息或發新訊息（附件跟第一個 chunk 一起發）
    const firstPayload: Record<string, unknown> = { content: chunks[0] };
    if (attachments.length) firstPayload.files = attachments;

    if (progressMsg) {
      await progressMsg.edit(firstPayload).catch(() => {});
      sentIds.push(progressMsg.id);
    } else {
      const sent = await message.reply(firstPayload);
      sentIds.push(sent.id);
    }

    // 剩餘 chunks：用 reply 發新訊息
    for (let i = 1; i < chunks.length; i++) {
      const sent = await message.reply(chunks[i]);
      sentIds.push(sent.id);
    }

    if (sentIds.length > 0) {
      session.setLastAssistantMsgId(sentIds.join(","));
    }
    logger.info({ sessionId: session.id, chunks: chunks.length, sentIds }, "discord reply sent");
  } catch (err) {
    logger.error({ err: (err as Error).message, stack: (err as Error).stack }, "discord handle trigger failed");
    if (progressMsg) await progressMsg.delete().catch(() => {});
    await message.react("🤕").catch(() => {});
  } finally {
    clearInterval(typingInterval);
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
