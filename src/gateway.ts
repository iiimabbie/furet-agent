import { schedule, type ScheduledTask } from "node-cron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { logger } from "./logger.js";
import { ask } from "./agent.js";
import { loadCrons, type CronJob } from "./tools/builtin/cron.js";
import { loadReminders, saveReminders, type Reminder } from "./tools/builtin/reminder.js";
import { getDiscordClient } from "./tools/builtin/discord.js";
import { startBot } from "./bot.js";
import { Session } from "./session.js";
import { SESSION_SUMMARIZE_PROMPT, buildJournalPrompt, authoritativeNowBlock } from "./prompt.js";
import { loadConfig } from "./config.js";
import { fixMarkdownLinks } from "./utils/format.js";
import { chunkMessage } from "./utils/chunk-message.js";
import { isNoReplySentinel } from "./utils/no-reply.js";
import { ROOT } from "./paths.js";
import { stamp, today } from "./utils/time.js";
import { loadPlugins, startPlugins, stopPlugins } from "./tools/plugin-loader.js";

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
    // Discord 2000 字元限制；跨段時維持 fenced code block 完整。
    for (const chunk of chunkMessage(formatted, 2000)) {
      const sent = await channel.send(chunk);
      sentIds.push(sent.id);
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
async function sendAndPersist(channelId: string, text: string, label: string): Promise<void> {
  const sentIds = await sendToChannel(channelId, text);
  if (sentIds.length === 0) return;
  const sessionId = await resolveSessionIdForChannel(channelId);
  if (!sessionId) return;
  const session = new Session(sessionId);
  try {
    const channel = await getDiscordClient()?.channels.fetch(channelId);
    const channelName = (channel as { name?: string } | null)?.name;
    if (channelName) session.setChannelName(channelName);
  } catch { /* 取名失敗不影響推播 */ }
  const ts = stamp();
  // session 是空的時候不能直接 append assistant——Anthropic API 要求第一則是 user，
  // 否則這個頻道下次對話會直接 400。先補一則說明這是排程主動推播。
  if (session.length === 0) {
    session.append({
      role: "user",
      content: `[System] ${label} pushed the following message to this channel proactively (no user message preceded it).`,
      time: ts,
    });
  }
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
      const notifyInstruction = job.notify === "on_event"
        ? "If the result is normal / OK with nothing to report, reply with exactly `[no_reply]` and nothing else — the owner will NOT be notified. Only reply with actual content when there is an error, anomaly, or something genuinely worth the owner's attention."
        : "Your text response will be automatically delivered to the correct channel.";
      // authoritativeNowBlock() 在觸發當下用 nowWithZone() 鎖定權威本地時間，
      // 壓過任何上游脈絡帶進來的舊日期，避免把「今天」判成前一天。
      const cronContext =
        authoritativeNowBlock() +
        `[System] The scheduled task "${job.name}" you set up is now running. ` +
        `Below is the instruction you left for your future self — carry it out now and write the actual message for the user. ` +
        `It is an instruction, not a message to repeat verbatim; anything in it that depends on "today" must be looked up or recomputed against the authoritative datetime above. ` +
        `Do NOT use discord_send_message — just reply with text. ${notifyInstruction}\n\n`;
      const response = await ask(cronContext + job.prompt, { trigger: "cron" });
      // 與一般 Discord 對話共用同一套哨符判定（utils/no-reply.ts）：
      // trim 後整則相等、大小寫不敏感，避免把夾帶正常內容的回覆整個誤吞。
      const isNoreply = isNoReplySentinel(response.text);
      logger.info({ id: job.id, noreply: isNoreply, result: response.text.slice(0, 200) }, "cron result");
      if (job.channel_id && response.text && !isNoreply) {
        await sendAndPersist(job.channel_id, response.text, `Scheduled task "${job.name}"`);
      } else if (!isNoreply) {
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
  // Reload cron jobs every hour
  setInterval(() => {
    loadAndScheduleAll();
  }, 60 * 60 * 1000);
  // 每 15 秒掃一次到期的提醒
  setInterval(() => {
    void tickReminders();
  }, REMINDER_POLL_MS);
}

// --- Reminders ---
/**
 * 提醒用輪詢而不是 setTimeout：檔案是唯一真相，手改 reminders.json 立即生效，
 * 沒有 setTimeout 的 32-bit delay 上限，停機期間錯過的到期提醒下次掃到就會補發。
 */
const REMINDER_POLL_MS = 15 * 1000;

/** 已經在跑的提醒，避免同一筆被下一輪重複撈到 */
const runningReminders = new Set<string>();

async function tickReminders(): Promise<void> {
  const now = Date.now();
  const due = loadReminders().filter(
    r => !runningReminders.has(r.id) && new Date(r.triggerAt).getTime() <= now
  );
  for (const r of due) {
    runningReminders.add(r.id);
    // 先移除再執行：中途崩潰不會在重啟後重複推播
    removeReminder(r.id);
    void runReminder(r).finally(() => runningReminders.delete(r.id));
  }
}

async function runReminder(r: Reminder): Promise<void> {
  const lateBySec = Math.round((Date.now() - new Date(r.triggerAt).getTime()) / 1000);
  logger.info({ id: r.id, name: r.name, lateBySec, prompt: r.prompt.slice(0, 100) }, "reminder triggered");
  try {
    // authoritativeNowBlock() 在觸發當下用 nowWithZone() 鎖定權威本地時間，
    // 壓過任何上游脈絡帶進來的舊日期；相對時間一律對這個時間重算。
    const reminderContext =
      authoritativeNowBlock() +
      `[System] The reminder "${r.name}" you scheduled earlier has just fired. ` +
      `Below is the instruction you left for your future self — carry it out now and write the actual message for the user. ` +
      `It is an instruction, not a message to repeat verbatim. ` +
      `Any relative time in it (dates, days remaining) must be recomputed against the authoritative datetime above; ` +
      `this reminder was due at ${r.triggerAt} and may be firing late. ` +
      `Your text response is delivered to the user automatically — do NOT use discord_send_message, just reply with text.\n\n`;
    const response = await ask(reminderContext + r.prompt, { trigger: "reminder" });
    logger.info({ id: r.id, result: response.text.slice(0, 200) }, "reminder result");
    if (r.channel_id && response.text) {
      await sendAndPersist(r.channel_id, response.text, `Reminder "${r.name}"`);
    } else {
      console.log(`[reminder:${r.name}] ${response.text}`);
    }
  } catch (err) {
    logger.error({ id: r.id, err }, "reminder execution failed");
  }
}

function removeReminder(id: string): void {
  saveReminders(loadReminders().filter(r => r.id !== id));
}

// --- Journal ---

/** 總結並歸檔所有 active session */
async function summarizeAndArchiveAll(): Promise<void> {
  const ids = Session.listActive();
  if (ids.length === 0) return;

  const ts = stamp();

  for (const id of ids) {
    const session = new Session(id);
    if (session.length === 0) continue;
    try {
      const flushContext = `[System] ${SESSION_SUMMARIZE_PROMPT}`;
      session.append({ role: "user", content: "[System] Session ending — flush memory now.", time: ts });
      await ask(null, { session, systemPrompt: flushContext, trigger: "journal" });
      session.archive();
      logger.info({ sessionId: id }, "memory flushed and archived (journal)");
    } catch (err) {
      logger.error({ err: (err as Error).message, sessionId: id }, "memory flush failed (journal)");
      session.archive(); // flush 失敗也歸檔，避免 context 無限增長
    }
  }
}

function scheduleJournal(): void {
  const config = loadConfig();
  if (!config.journal.enabled) return;

  const expr = `${config.journal.minute} ${config.journal.hour} * * *`;
  schedule(expr, async () => {
    logger.info({ time: `${config.journal.hour}:${config.journal.minute}` }, "journal triggered");

    // 先鎖定今天的日期，避免 summarize 耗時跨日導致日期錯誤
    const date = today();

    // 總結+歸檔所有 active session
    await summarizeAndArchiveAll();

    // 再整理日記 + 更新 MEMORY.md
    const prompt = buildJournalPrompt(date);
    ask(prompt, { trigger: "journal" })
      .then(response => logger.info({ date, result: response.text.slice(0, 200) }, "journal done"))
      .catch(err => logger.error({ err, date }, "journal failed"));
  });
  logger.info({ expr }, "journal scheduled");
  console.log(`Journal scheduled at ${config.journal.hour}:${String(config.journal.minute).padStart(2, "0")} daily`);
}

// --- PID file: kill old instance before starting ---
const PID_FILE = `${ROOT}/furet.pid`;

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

// 初始化 SQLite（建表）
import { getDb } from "./db.js";
getDb();

// Load & start private plugins BEFORE background services accept traffic (cron/reminder/
// journal/Discord). A plugin's failure is isolated and logged inside the loader; it never
// crashes the gateway.
await loadPlugins();
await startPlugins();

loadAndScheduleAll();
console.log(`Loaded ${loadReminders().length} reminders`);
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

/**
 * Graceful shutdown shared by SIGINT / SIGTERM. Stops plugins (per-plugin isolated inside
 * stopPlugins), removes the PID file, then exits 0 so systemd (Restart=always) and
 * /restart keep working exactly as before. A hard timeout guarantees exit even if a
 * plugin's stop() hangs — shutdown must never wedge.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Safety net: force-exit if graceful stop takes too long.
  const forceTimer = setTimeout(() => {
    logger.warn({ signal }, "graceful shutdown timed out; forcing exit");
    process.exit(0);
  }, 5000);
  forceTimer.unref?.();
  try {
    await stopPlugins();
  } catch (err) {
    logger.error({ err }, "stopPlugins threw during shutdown");
  }
  cleanup();
  if (signal === "SIGINT") console.log("\nGateway stopped.");
  logger.info({ signal }, "gateway stop");
  clearTimeout(forceTimer);
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
