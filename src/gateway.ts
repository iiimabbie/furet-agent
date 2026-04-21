import { schedule, type ScheduledTask } from "node-cron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { logger } from "./logger.js";
import { ask } from "./agent.js";
import { loadCrons, type CronJob } from "./tools/builtin/cron.js";
import { loadReminders, saveReminders, type Reminder } from "./tools/builtin/reminder.js";
import { getDiscordClient } from "./tools/builtin/discord.js";
import { startBot } from "./bot.js";
import { Session } from "./session.js";
import { SESSION_SUMMARIZE_PROMPT, buildJournalPrompt } from "./prompt.js";
import { loadConfig } from "./config.js";
import { fixMarkdownLinks } from "./utils/format.js";
import { ROOT } from "./paths.js";

async function sendToChannel(channelId: string, text: string): Promise<string[]> {
  const client = getDiscordClient();
  if (!client) return [];
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      logger.warn({ channelId }, "channel not found or not text-based");
      return [];
    }
    const formatted = fixMarkdownLinks(text);
    const sentIds: string[] = [];
    // Discord 2000 字元限制
    if (formatted.length <= 2000) {
      const sent = await channel.send(formatted);
      sentIds.push(sent.id);
    } else {
      let remaining = formatted;
      while (remaining.length > 0) {
        let cutAt = remaining.lastIndexOf("\n", 2000);
        if (cutAt < 1000) cutAt = 2000;
        const sent = await channel.send(remaining.slice(0, cutAt));
        sentIds.push(sent.id);
        remaining = remaining.slice(cutAt).trimStart();
      }
    }
    return sentIds;
  } catch (err) {
    logger.error({ err: (err as Error).message, channelId }, "failed to send to channel");
    return [];
  }
}

/** 根據 channel_id 解析出對應的 session ID（DM 要用 user id） */
async function resolveSessionIdForChannel(channelId: string): Promise<string | null> {
  const client = getDiscordClient();
  if (!client) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return null;
    if (channel.isDMBased()) {
      const recipientId = (channel as { recipient?: { id: string } }).recipient?.id;
      return recipientId ? `discord-dm-${recipientId}` : null;
    }
    return `discord-channel-${channelId}`;
  } catch {
    return null;
  }
}

/** 發訊息到 channel 並把 assistant 回覆 append 進對應 session（附 msgId） */
async function sendAndPersist(channelId: string, text: string): Promise<void> {
  const sentIds = await sendToChannel(channelId, text);
  if (sentIds.length === 0) return;
  const sessionId = await resolveSessionIdForChannel(channelId);
  if (!sessionId) return;
  const session = new Session(sessionId);
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(5, 16).replace("-", "/");
  session.append({
    role: "assistant",
    content: text,
    time: ts,
    msgId: sentIds.join(","),
  });
}

const activeTasks = new Map<string, ScheduledTask>();

function scheduleCron(job: CronJob): void {
  if (activeTasks.has(job.id)) {
    activeTasks.get(job.id)!.stop();
  }

  const task = schedule(job.schedule, async () => {
    logger.info({ id: job.id, name: job.name, prompt: job.prompt.slice(0, 100) }, "cron triggered");
    try {
      const response = await ask(job.prompt);
      logger.info({ id: job.id, result: response.text.slice(0, 200) }, "cron result");
      if (job.channel_id && response.text) {
        await sendAndPersist(job.channel_id, response.text);
      } else {
        console.log(`[cron:${job.name}] ${response.text}`);
      }
    } catch (err) {
      logger.error({ id: job.id, err }, "cron execution failed");
    }
  });

  activeTasks.set(job.id, task);
}

function loadAndScheduleAll(): void {
  for (const task of activeTasks.values()) task.stop();
  activeTasks.clear();

  const jobs = loadCrons();
  let count = 0;
  for (const job of jobs) {
    if (!job.enabled) continue;
    try {
      scheduleCron(job);
      count++;
    } catch (err) {
      logger.error({ id: job.id, schedule: job.schedule, err }, "invalid cron schedule");
    }
  }
  console.log(`Loaded ${count} cron jobs (${jobs.length} total)`);
}

function startWatcher(): void {
  setInterval(() => {
    loadAndScheduleAll();
    loadAndScheduleReminders();
  }, 60 * 60 * 1000);
}

// --- Reminders ---
const activeReminders = new Map<string, NodeJS.Timeout>();

function scheduleReminder(r: Reminder): void {
  if (activeReminders.has(r.id)) {
    clearTimeout(activeReminders.get(r.id)!);
  }
  const delay = new Date(r.triggerAt).getTime() - Date.now();
  if (delay <= 0) {
    removeReminder(r.id);
    return;
  }
  const timeout = setTimeout(async () => {
    logger.info({ id: r.id, name: r.name, prompt: r.prompt.slice(0, 100) }, "reminder triggered");
    try {
      const response = await ask(r.prompt);
      logger.info({ id: r.id, result: response.text.slice(0, 200) }, "reminder result");
      if (r.channel_id && response.text) {
        await sendAndPersist(r.channel_id, response.text);
      } else {
        console.log(`[reminder:${r.name}] ${response.text}`);
      }
    } catch (err) {
      logger.error({ id: r.id, err }, "reminder execution failed");
    }
    removeReminder(r.id);
  }, delay);
  activeReminders.set(r.id, timeout);
}

function removeReminder(id: string): void {
  const list = loadReminders().filter(r => r.id !== id);
  saveReminders(list);
  const t = activeReminders.get(id);
  if (t) {
    clearTimeout(t);
    activeReminders.delete(id);
  }
}

function loadAndScheduleReminders(): void {
  const list = loadReminders();
  let count = 0;
  for (const r of list) {
    if (!activeReminders.has(r.id)) {
      scheduleReminder(r);
      count++;
    }
  }
  if (count > 0) {
    logger.info({ count, total: list.length }, "new reminders scheduled");
  }
}

// --- Journal ---

/** 總結並歸檔所有 active session */
async function summarizeAndArchiveAll(): Promise<void> {
  const ids = Session.listActive();
  if (ids.length === 0) return;

  const ts = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(5, 16).replace("-", "/");
  const summarizePrompt = SESSION_SUMMARIZE_PROMPT;

  for (const id of ids) {
    const session = new Session(id);
    if (session.length === 0) continue;
    try {
      session.append({ role: "user", content: summarizePrompt, time: ts });
      await ask(null, { session });
      session.archive();
      logger.info({ sessionId: id }, "session summarized and archived (journal)");
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId: id }, "session summarize failed (journal)");
      session.archive(); // 總結失敗也歸檔，避免 context 無限增長
    }
  }
}

function scheduleJournal(): void {
  const config = loadConfig();
  if (!config.journal.enabled) return;

  const expr = `${config.journal.minute} ${config.journal.hour} * * *`;
  schedule(expr, async () => {
    logger.info({ time: `${config.journal.hour}:${config.journal.minute}` }, "journal triggered");

    // 先總結+歸檔所有 active session
    await summarizeAndArchiveAll();

    // 再整理日記 + 更新 MEMORY.md
    const date = new Date().toISOString().split("T")[0];
    const prompt = buildJournalPrompt(date);
    ask(prompt)
      .then(response => logger.info({ date, result: response.text.slice(0, 200) }, "journal done"))
      .catch(err => logger.error({ err, date }, "journal failed"));
  });
  logger.info({ expr }, "journal scheduled");
  console.log(`Journal scheduled at ${config.journal.hour}:${String(config.journal.minute).padStart(2, "0")} daily`);
}

// --- PID file: kill old instance before starting ---
const PID_FILE = `${ROOT}/furet-pi.pid`;

if (existsSync(PID_FILE)) {
  const raw = readFileSync(PID_FILE, "utf-8").trim();
  const oldPid = parseInt(raw, 10);
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, "SIGTERM");
      console.log(`Killed old gateway (PID ${oldPid})`);
      logger.info({ oldPid }, "killed old gateway");
    } catch {
      // process already gone, ignore
    }
  }
}

writeFileSync(PID_FILE, String(process.pid));

// --- Start ---
console.log("Furet Gateway starting...");
logger.info("gateway start");

loadAndScheduleAll();
loadAndScheduleReminders();
scheduleJournal();
startWatcher();

const config = loadConfig();
if (config.discord.enabled && config.discord.token) {
  await startBot(config.discord.token).catch(err => {
    logger.error({ err }, "discord bot failed to start");
    console.error("Discord bot failed:", err.message);
  });
} else {
  console.log("Discord bot disabled.");
}

console.log("Furet Gateway running. Press Ctrl+C to stop.");

function cleanup() {
  try {
    // only remove if we still own the PID file
    if (existsSync(PID_FILE) && readFileSync(PID_FILE, "utf-8").trim() === String(process.pid)) {
      writeFileSync(PID_FILE, "");
    }
  } catch {}
}

process.on("SIGINT", () => {
  cleanup();
  console.log("\nGateway stopped.");
  logger.info("gateway stop");
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  logger.info("gateway stop (SIGTERM)");
  process.exit(0);
});
