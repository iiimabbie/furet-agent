import {
  Client, GatewayIntentBits, Events, REST, Routes,
  SlashCommandBuilder, MessageFlags, EmbedBuilder, ActivityType, PresenceStatusData,
  ActionRowBuilder,
  type Message, type Interaction, type TextBasedChannel,
} from "discord.js";
import { ask, compactSession } from "./agent.js";
import { Session } from "./session.js";
import { SESSION_SUMMARIZE_PROMPT } from "./prompt.js";
import { logger } from "./logger.js";
import { loadConfig, REASONING_EFFORTS, setModelConfig, type ReasoningEffort } from "./config.js";
import { setDiscordClient } from "./tools/builtin/discord.js";
import { executeTool } from "./tools/registry.js";
import { runWithContext } from "./tools/context.js";
import { handleDiscordButtonInteraction } from "./discord-buttons.js";
import { fixMarkdownLinks } from "./utils/format.js";
import { chunkMessage } from "./utils/chunk-message.js";
import { normalizeMentions, formatName } from "./utils/discord-mentions.js";
import { estimateCost } from "./utils/pricing.js";
import { stamp } from "./utils/time.js";
import { isNoReplySentinel } from "./utils/no-reply.js";
import { getPluginRuntimeStatus } from "./tools/plugin-loader.js";
import {
  installPlugin,
  listManagedPluginNames,
  removeManagedPlugin,
  updatePlugins,
} from "./plugin-manager.js";
import { syncApplicationEmojis, resolveEmojiMarkup } from "./emoji.js";
import { KeyedSerialQueue } from "./utils/keyed-serial-queue.js";
import { shouldOnboard, buildOnboardingContext, isWorkspaceUnconfigured } from "./onboarding.js";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCrons } from "./tools/builtin/cron.js";
import { getAuthClient, getAuthUrl, exchangeCode } from "./google/auth.js";
import { google } from "googleapis";
import { loadReminders } from "./tools/builtin/reminder.js";
import type { TokenUsage, ProgressEvent } from "./types.js";

function buildChannelContext(channelId: string, sessionId: string, extra?: string): string {
  const lines = [
    `<discord-context>`,
    `Channel ID: ${channelId}`,
    ...(extra ? [extra] : []),
    `Session: ${sessionId}`,
    `Use this channel_id when creating reminders or cron jobs for this conversation.`,
    `</discord-context>`,
  ];
  return lines.join("\n");
}

function getChannelTypeInfo(channel: TextBasedChannel | null | undefined): string {
  if (!channel) return "";
  const channelType = channel.isThread()
    ? (channel.parent && "type" in channel.parent && channel.parent.type === 15 ? "forum post" : "thread")
    : (channel.isDMBased() ? "DM" : "channel");
  const parentInfo = channel.isThread() && channel.parentId ? `Parent channel: ${channel.parentId}` : "";
  const threadName = channel.isThread() ? `Thread name: "${channel.name}"` : "";
  return [
    `Channel type: ${channelType}`,
    parentInfo,
    threadName,
  ].filter(Boolean).join("\n");
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
    .addStringOption(opt =>
      opt.setName("effort")
        .setDescription("思考等級（省略時使用模型預設）")
        .setRequired(false)
        .addChoices(...REASONING_EFFORTS.map(value => ({
          name: value === "default" ? "default（模型預設）" : value,
          value,
        })))
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
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("壓縮當前 session（摘要舊對話，保留最近訊息）")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("plugin")
    .setDescription("安裝、更新或卸載 Furet 外掛（owner only）")
    .addStringOption(opt =>
      opt.setName("動作")
        .setDescription("選擇要執行的外掛操作")
        .setRequired(true)
        .addChoices(
          { name: "安裝", value: "install" },
          { name: "更新", value: "update" },
          { name: "卸載", value: "remove" },
        )
    )
    .addStringOption(opt =>
      opt.setName("目標")
        .setDescription("安裝時貼 GitHub 網址；更新或卸載時選外掛（更新留空＝全部）")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .toJSON(),
];

const OWNER_ONLY_MSG = "只有 owner 能用這個指令！";
// Discord.js does not await async MessageCreate listeners. Serialize all work that
// touches the same session so a later message cannot enter the session or start an
// agent request before the previous reply has been fully delivered.
const discordSessionQueue = new KeyedSerialQueue();

interface PendingRestart {
  applicationId: string;
  token: string;
  createdAt: number;
}

const RESTART_STATE_FILE = join(tmpdir(), `furet-restart-${process.getuid?.() ?? "unknown"}.json`);
const RESTART_TOKEN_TTL_MS = 14 * 60 * 1000;
const execFileAsync = promisify(execFile);

async function savePendingRestart(applicationId: string, token: string): Promise<void> {
  const state: PendingRestart = { applicationId, token, createdAt: Date.now() };
  await writeFile(RESTART_STATE_FILE, JSON.stringify(state), { mode: 0o600 });
}

async function completePendingRestart(): Promise<void> {
  let state: PendingRestart;
  try {
    state = JSON.parse(await readFile(RESTART_STATE_FILE, "utf8")) as PendingRestart;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err: (err as Error).message }, "failed to read pending restart state");
    }
    return;
  }

  const isValid = typeof state.applicationId === "string"
    && typeof state.token === "string"
    && typeof state.createdAt === "number";
  if (!isValid || Date.now() - state.createdAt > RESTART_TOKEN_TTL_MS) {
    await unlink(RESTART_STATE_FILE).catch(() => {});
    logger.warn("discarded invalid or expired pending restart state");
    return;
  }

  const url = `https://discord.com/api/v10/webhooks/${encodeURIComponent(state.applicationId)}/${encodeURIComponent(state.token)}/messages/@original`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "重啟成功，已經回來了。" }),
  });
  if (!response.ok) {
    throw new Error(`Discord interaction edit failed: ${response.status} ${await response.text()}`);
  }

  await unlink(RESTART_STATE_FILE).catch(() => {});
  logger.info("pending restart message updated successfully");
}

/** 讓 process 退出，由 systemd (Restart=always) 負責重啟。 */
function selfRestart(): void {
  logger.info("self-restart: exiting, systemd will restart");
  process.exit(0);
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

async function parseGitHubPluginSource(source: string): Promise<{ repository: string; workspace?: string; ref?: string }> {
  const url = new URL(source);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Discord installation only accepts an HTTPS GitHub link");
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials or tokens in the GitHub link");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) throw new Error("Enter a complete GitHub repository link");

  const owner = segments[0];
  const repositoryName = segments[1].replace(/\.git$/i, "");
  const repository = `https://github.com/${owner}/${repositoryName}.git`;
  if (segments.length === 2) return { repository };

  if (segments[2] !== "tree" || segments.length < 5) {
    throw new Error("Use a repository link or a GitHub /tree/<branch>/<package> link");
  }

  const treePath = segments.slice(3).map(segment => decodeURIComponent(segment)).join("/");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["ls-remote", "--heads", repository], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to inspect GitHub branches: ${detail}`);
  }

  const refs = stdout
    .split("\n")
    .map(line => line.match(/\trefs\/heads\/(.+)$/)?.[1])
    .filter((ref): ref is string => Boolean(ref))
    .sort((a, b) => b.length - a.length);
  const ref = refs.find(candidate => treePath.startsWith(`${candidate}/`));
  if (!ref) {
    throw new Error("The GitHub tree link does not contain a valid branch and package path");
  }

  const workspace = treePath.slice(ref.length + 1);
  return { repository, workspace, ref };
}

function truncateInteractionReply(content: string): string {
  const limit = 1_900;
  return content.length <= limit ? content : `${content.slice(0, limit)}\n…output truncated`;
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

    await completePendingRestart().catch(err =>
      logger.error({ err: (err as Error).message }, "failed to update restart completion message")
    );

    const guildIds = c.guilds.cache.map(g => g.id);
    await registerSlashCommands(token, c.user.id, guildIds);

    // Sync Application Emojis into the in-memory cache. Failure is non-fatal: the
    // helper logs the original Error and leaves the cache empty (safe no-emoji mode),
    // so the bot never fails to start over this.
    await syncApplicationEmojis(c);

    if (!config.discord.owner_id) {
      console.log("Discord owner is not configured. Run `furet onbord` locally, then use the bot in Discord.");
      logger.warn("fresh install awaiting local onboarding command");
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      const handled = await handleDiscordButtonInteraction(
        interaction,
        client,
        (toolName, args) => {
          const trigger = interaction.user.id === loadConfig().discord.owner_id ? "discord-owner" : "discord-other";
          return runWithContext(
            trigger,
            interaction.user.id,
            loadConfig().llm.currentModel,
            () => executeTool(toolName, args),
          );
        },
      );
      if (handled) return;
    } catch (err) {
      logger.error({ err, customId: "customId" in interaction ? interaction.customId : undefined }, "Discord button interaction failed");
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "處理按鈕互動時發生錯誤，請先不要重複操作；可查看原訊息狀態或日誌確認結果。", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "model") {
        const focused = interaction.options.getFocused();
        const { llm } = loadConfig();
        const filtered = llm.modelList
          .filter(m => m.includes(focused))
          .slice(0, 25);
        await interaction.respond(filtered.map(m => ({ name: m, value: m })));
        return;
      }

      if (interaction.commandName === "plugin") {
        if (interaction.user.id !== loadConfig().discord.owner_id) {
          await interaction.respond([]);
          return;
        }
        const action = interaction.options.getString("動作");
        if (action !== "update" && action !== "remove") {
          await interaction.respond([]);
          return;
        }
        const focused = interaction.options.getFocused().toLowerCase();
        const names = listManagedPluginNames()
          .filter(name => name.toLowerCase().includes(focused))
          .slice(0, 25);
        await interaction.respond(names.map(name => ({ name, value: name })));
        return;
      }

    }

    if (!interaction.isChatInputCommand()) return;

    // Before the local installer records owner_id, reject every Discord command.
    // This is intentionally before any session write or owner-only command check.
    if (!loadConfig().discord.owner_id) {
      await interaction.reply({ content: "請在主機本機執行 `furet onbord` 完成 Discord owner 設定。", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "new") {
      const config = loadConfig();
      if (isWorkspaceUnconfigured() && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply({ content: "首次設定尚未完成，只有已設定的 owner 能重開 onboarding session。", flags: MessageFlags.Ephemeral });
        return;
      }
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;

      // Defer before waiting behind an in-flight reply so the interaction token
      // remains valid, then mutate/archive the session inside the same FIFO queue.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await discordSessionQueue.enqueue(sessionId, async () => {
        const session = new Session(sessionId);
        const channelContext = buildChannelContext(interaction.channelId, sessionId, getChannelTypeInfo(interaction.channel));
        const ts = stamp();

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

        if (shouldOnboard(session.getMessages())) {
          session.append({
            role: "user",
            content: buildOnboardingContext(interaction.user.id, interaction.user.username),
            time: ts,
            isOnboarding: true,
          });
        }
        const newSessionContent = `[System] <@${interaction.user.id}>(${interaction.user.username}) started a new session via /new. Follow the Session Initialization steps in your instructions (MEMORY.md and PEOPLE.md are already in your prompt — read only the recent daily memory), then greet them in character.`;
        session.append({ role: "user", content: newSessionContent, time: ts });

        try {
          const response = await ask(null, { session, systemPrompt: channelContext, trigger: "discord-owner" });
          const text = response.text || "（新對話開始）";
          const formatted = fixMarkdownLinks(resolveEmojiMarkup(text));
          const chunks = chunkMessage(formatted, 2000);
          await interaction.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(chunks[i]);
          }
        } catch (err) {
          logger.error({ err: (err as Error).message }, "/new failed");
          await interaction.deleteReply().catch(() => {});
        }
      }).catch(err => {
        logger.error({ err, sessionId }, "queued /new handling failed");
      });
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
      const pluginStatus = getPluginRuntimeStatus();

      const totalTokens = usage.inputTokens + usage.outputTokens;
      const cost = estimateCost(usage, config.llm.currentModel);

      const embed = new EmbedBuilder()
        .setTitle("Furet Status")
        .addFields(
          { name: "Model", value: `\`${config.llm.currentModel}\``, inline: true },
          { name: "Reasoning", value: `\`${config.llm.reasoningEffort}\``, inline: true },
          { name: "Cost", value: cost, inline: true },
          { name: "Tokens", value: `${totalTokens.toLocaleString()} (in: ${usage.inputTokens.toLocaleString()} / out: ${usage.outputTokens.toLocaleString()})`, inline: false },
          { name: "Active Sessions", value: `${activeSessions.length}`, inline: true },
          { name: "Crons", value: `${crons.filter(c => c.enabled).length} active / ${crons.length} total`, inline: true },
          { name: "Reminders", value: `${reminders.length} pending`, inline: true },
          { name: "Plugin Jobs", value: `${pluginStatus.activeSchedules} scheduled / ${pluginStatus.runningJobs} running`, inline: true },
          { name: "Plugins", value: pluginStatus.plugins.length > 0
            ? pluginStatus.plugins.map(p => `${p.name} (${p.state})`).join(", ")
            : "none", inline: false },
          { name: "Skills", value: skills.length > 0 ? skills.join(", ") : "none", inline: false },
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "restart") {
      const config = loadConfig();
      if (config.discord.owner_id && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply({ content: OWNER_ONLY_MSG, flags: MessageFlags.Ephemeral });
        return;
      }
      logger.info({ user: interaction.user.id }, "/restart triggered");
      await interaction.reply({ content: "重啟中... 等個幾秒就回來。", flags: MessageFlags.Ephemeral });
      try {
        await savePendingRestart(interaction.applicationId, interaction.token);
      } catch (err) {
        logger.error({ err: (err as Error).message }, "failed to save pending restart state");
        await interaction.editReply("重啟取消：無法保存重啟狀態。");
        return;
      }
      selfRestart();
    }

    if (interaction.commandName === "model") {
      const config = loadConfig();
      if (config.discord.owner_id && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply({ content: OWNER_ONLY_MSG, flags: MessageFlags.Ephemeral });
        return;
      }
      const name = interaction.options.getString("name", true);
      if (config.llm.modelList.length > 0 && !config.llm.modelList.includes(name)) {
        await interaction.reply({ content: `不在 modelList 裡：\`${name}\``, flags: MessageFlags.Ephemeral });
        return;
      }
      const effort = (interaction.options.getString("effort") ?? "default") as ReasoningEffort;
      const prev = config.llm.currentModel;
      const prevEffort = config.llm.reasoningEffort;
      setModelConfig(name, effort);
      logger.info({ prev, next: name, prevEffort, effort, user: interaction.user.id }, "/model switched");
      await interaction.reply({
        content: `模型已切換：\`${prev} (${prevEffort})\` → \`${name} (${effort})\``,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.commandName === "google-auth") {
      const config = loadConfig();
      if (config.discord.owner_id && interaction.user.id !== config.discord.owner_id) {
        await interaction.reply({ content: OWNER_ONLY_MSG, flags: MessageFlags.Ephemeral });
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

    if (interaction.commandName === "compact") {
      const sessionId = interaction.guild
        ? `discord-channel-${interaction.channelId}`
        : `discord-dm-${interaction.user.id}`;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await discordSessionQueue.enqueue(sessionId, async () => {
        const session = new Session(sessionId);
        if (session.length === 0) {
          await interaction.editReply("Session 是空的，不需要壓縮。");
          return;
        }
        const summary = await compactSession(session);
        if (summary) {
          await interaction.editReply(`Session 已壓縮（${session.length} 則訊息保留）。`);
        } else {
          await interaction.editReply("Session 太短，不需要壓縮。");
        }
      }).catch(async err => {
        logger.error({ err, sessionId }, "queued /compact handling failed");
        await interaction.editReply("Session 壓縮失敗，請查看日誌。").catch(() => {});
      });
    }

    if (interaction.commandName === "plugin") {
      const config = loadConfig();
      if (interaction.user.id !== config.discord.owner_id) {
        await interaction.reply({ content: OWNER_ONLY_MSG, flags: MessageFlags.Ephemeral });
        return;
      }

      const action = interaction.options.getString("動作", true);
      const target = interaction.options.getString("目標")?.trim() || undefined;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (action === "install") {
          if (!target) throw new Error("請在「目標」貼上 GitHub repository 或 package 網址");
          const source = await parseGitHubPluginSource(target);
          const result = await installPlugin(source.repository, { workspace: source.workspace, ref: source.ref });
          logger.info({ operation: "install", user: interaction.user.id }, "/plugin interaction completed");
          await interaction.editReply(truncateInteractionReply(result));
          return;
        }

        if (action === "update") {
          if (target && !listManagedPluginNames().includes(target)) {
            throw new Error(`Managed plugin ${target} is not installed`);
          }
          const result = await updatePlugins(target);
          logger.info({ operation: "update", plugin: target, user: interaction.user.id }, "/plugin interaction completed");
          await interaction.editReply(truncateInteractionReply(result));
          return;
        }

        if (action !== "remove") throw new Error("未知的外掛操作");
        if (!target) throw new Error("請在「目標」選擇要卸載的外掛");
        if (!listManagedPluginNames().includes(target)) {
          throw new Error(`Managed plugin ${target} is not installed`);
        }
        const result = removeManagedPlugin(target);
        logger.info({ operation: "remove", plugin: target, user: interaction.user.id }, "/plugin interaction completed");
        await interaction.editReply(truncateInteractionReply(result));
      } catch (err) {
        const message = (err as Error).message;
        logger.error({ err, operation: action, user: interaction.user.id }, "/plugin interaction failed");
        const label = action === "install" ? "外掛安裝失敗" : action === "update" ? "外掛更新失敗" : "外掛卸載失敗";
        await interaction.editReply(truncateInteractionReply(`${label}：${message}`));
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    // 自己的訊息不處理
    if (message.author.id === client.user?.id) return;

    const config = loadConfig();
    const sessionId = sessionIdForMessage(message);
    const isMentioned = client.user ? message.mentions.has(client.user) : false;
    const isDM = !message.guild;
    const isBot = message.author.bot;
    // ambient 頻道：不需 @ 即觸發。只比對 channel ID 本身，thread 不繼承 parent
    const isAmbient = !isDM && config.discord.ambient_channels.includes(message.channelId);
    const isTrigger = (isMentioned || isDM || isAmbient) && (!isBot || config.discord.respond_to_bots);

    // A fresh gateway accepts no ordinary Discord traffic until the installer
    // has configured owner_id locally. This happens before session creation, so
    // strangers cannot poison a future owner session.
    if (!config.discord.owner_id) {
      if (isTrigger) logger.info({ userId: message.author.id, sessionId }, "message ignored while fresh-install setup is pending");
      return;
    }

    // DM 只回 owner
    if (isDM && message.author.id !== config.discord.owner_id) {
      logger.info({ userId: message.author.id }, "DM from non-owner rejected");
      return;
    }
    // owner 一律不受白名單限制——白名單是用來擋別人的，不是擋自己
    if (message.author.id !== config.discord.owner_id) {
      if (message.guild && config.discord.allowed_guilds.length > 0
          && !config.discord.allowed_guilds.includes(message.guild.id)) return;
      if (!isDM && !isAmbient && config.discord.allowed_channels.length > 0
          && !config.discord.allowed_channels.includes(message.channelId)) return;
    }

    // （只有 bot 被 @mention / reply / DM 後才會開啟這個 channel 的 session；
    //   之後該 channel 的所有訊息才會納入記錄，作為 reply chain 的上下文）
    // A context message arriving behind a queued trigger must not be dropped merely
    // because that trigger has not created the session file yet.
    if (!isTrigger && !Session.exists(sessionId) && !discordSessionQueue.has(sessionId)) return;

    await discordSessionQueue.enqueue(sessionId, async () => {
      const session = new Session(sessionId);
      // 檔名帶上頻道名，方便在 sessions/ 裡辨識；頻道改名會自動 rename
      const channelName = (message.channel as { name?: string }).name;
      if (channelName) session.setChannelName(channelName);

      // Setup context remains resumable until OWNER.md is completed.
      const needsOnboarding = isTrigger && shouldOnboard(session.getMessages());

      // Thread/論壇貼文的第一次進入：抓初始訊息作為 context
      if (session.length === 0 && message.channel.isThread()) {
        try {
          const starter = await message.channel.fetchStarterMessage();
          if (starter) {
            const ts = stamp(new Date(starter.createdTimestamp));
            const authorName = formatName(starter.author.username, starter.member?.displayName);
            const threadName = message.channel.name;
            session.append({
              role: "user",
              content: `[System] This is the initial message of forum post "${threadName}" (by ${authorName}) [thread_id: ${message.channelId}]:\n${starter.content}`,
              time: ts,
              msgId: starter.id,
            });
          }
        } catch { /* starter message not available */ }
      }

      // Inject one-time onboarding context before the user's actual message
      if (needsOnboarding) {
        const onboardingCtx = buildOnboardingContext(
          message.author.id,
          message.author.username,
          message.member?.displayName,
        );
        session.append({ role: "user", content: onboardingCtx, time: stamp(), isOnboarding: true });
        logger.info({ sessionId, userId: message.author.id }, "onboarding context injected");
      }

      const fmt = await formatIncomingMessage(message);
      const content = isTrigger ? fmt.content : `[context] ${fmt.content}`;
      session.append({ role: "user", content, time: fmt.time, msgId: fmt.msgId, ...(fmt.replyTo ? { replyTo: fmt.replyTo } : {}) });

      if (!isTrigger) return;

      await handleTrigger(message, session, fmt.images);
    }).catch(err => {
      logger.error({ err, sessionId, messageId: message.id }, "queued Discord message handling failed");
    });
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
  const authorName = formatName(message.author.username, message.member?.displayName);
  const authorId = message.author.id;

  const ts = stamp(new Date(message.createdTimestamp));
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
    content: `[msg:${message.id} ${ts}] <@${authorId}>(${authorName}):${message.reference?.messageId ? ` (reply to msg:${message.reference.messageId})` : ""} ${content}${attach}`,
    time: ts,
    msgId: message.id,
    ...(message.reference?.messageId ? { replyTo: message.reference.messageId } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

// --- Progress message editing ---

const PROGRESS_DEBOUNCE_MS = 1000;

/** 進度訊息的單行：工具狀態，或 tool call 之間的文字 */
export type ProgressLine =
  | { kind: "tool"; id: string; label: string; status: "running" | "ok" | "err" }
  | { kind: "text"; text: string };

/** 單段中途文字的顯示上限，避免佔滿 Discord 的 2000 字 */
const INTERIM_TEXT_LIMIT = 300;

export function renderProgress(lines: ProgressLine[]): string {
  if (lines.length === 0) return "...";
  const body = lines
    .map(l => {
      if (l.kind === "text") return `> ${l.text.replace(/\n+/g, "\n> ")}`;
      const icon = l.status === "running" ? "→" : l.status === "ok" ? "✓" : "✗";
      return `${icon} ${l.label}`;
    })
    .join("\n");
  // 過場訊息，超長時保留尾端即可
  return body.length > 1900 ? `${body.slice(-1900)}` : body;
}

// 靜默哨符判定集中在 utils/no-reply.ts，一般對話與排程共用同一套語意。
// 這裡 re-export，讓既有的 import path（含測試）維持不變。
export { isNoReplySentinel };

async function handleTrigger(message: Message, session: Session, images?: string[]): Promise<void> {
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

  const flushProgress = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastEditAt < PROGRESS_DEBOUNCE_MS) return;
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
      progressLines.push({ kind: "tool", id: event.toolCallId, label: event.toolName, status: "running" });
    } else if (event.type === "text") {
      const text = event.text.length > INTERIM_TEXT_LIMIT
        ? `${event.text.slice(0, INTERIM_TEXT_LIMIT)}…`
        : event.text;
      progressLines.push({ kind: "text", text });
    } else {
      const line = progressLines.find(l => l.kind === "tool" && l.id === event.toolCallId);
      if (line?.kind === "tool") line.status = event.isError ? "err" : "ok";
    }
    // 不套用 debounce：被延後的話這段文字可能到最後都沒顯示過
    flushChain = flushChain.then(() => flushProgress(event.type === "text"));
  };

  try {
    const channelContext = buildChannelContext(message.channelId, session.id, getChannelTypeInfo(channel));
    const isOwner = message.author.id === loadConfig().discord.owner_id;
    const response = await ask(null, { session, systemPrompt: channelContext, images, onProgress, trigger: isOwner ? "discord-owner" : "discord-other", userId: message.author.id });
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

    // 靜默哨符：模型最終文字整則就是 [no_reply]（trim + 大小寫不敏感）時，不送任何訊息。
    // 只在 Discord 最終輸出邊界攔截，不影響 session 記錄與 agent 執行流程。
    if (isNoReplySentinel(response.text)) {
      if (progressMsg) await progressMsg.delete().catch(() => {});
      logger.info({ sessionId: session.id }, "discord reply suppressed by [no_reply] sentinel");
      return;
    }

    // 若 AI 輸出 <@id>(帳號名｜暱稱) 格式，清掉括號讓 Discord 正常渲染 mention
    const stripped = response.text.replace(/(<@!?\d+>)[\(（][^\)）]*[\)）]/g, "$1");
    // 把 :name: 形式的 Application Emoji 引用解析成 Discord markup。
    // 在 chunk 前對整段文字做，才能正確跳過跨行的 code fence；名稱不存在則保留原文。
    const withEmojis = resolveEmojiMarkup(stripped);
    const formatted = fixMarkdownLinks(withEmojis);
    const chunks = chunkMessage(formatted, 2000);
    const sentIds: string[] = [];
    const attachments = response.attachments;

    // 第一個 chunk：編輯進度訊息或發新訊息（附件跟第一個 chunk 一起發）
    const firstPayload: Record<string, unknown> = { content: chunks[0] };
    if (attachments.length) firstPayload.files = attachments;

    if (progressMsg) {
      try {
        await progressMsg.edit(firstPayload);
        sentIds.push(progressMsg.id);
      } catch (err) {
        // Editing the progress message can fail while uploading attachments. Do not
        // silently leave the user with a stale ✓ tool-status message: log the real
        // error and fall back to a fresh reply carrying the same payload.
        logger.error({ err, attachmentCount: attachments.length }, "final progress message edit failed; sending fallback reply");
        const sent = await message.reply(firstPayload);
        sentIds.push(sent.id);
        await progressMsg.delete().catch(deleteErr =>
          logger.warn({ err: deleteErr }, "failed to delete stale progress message after fallback")
        );
      }
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
    logger.error({ err }, "discord handle trigger failed");
    if (progressMsg) await progressMsg.delete().catch(() => {});
    await message.react("🤕").catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}
