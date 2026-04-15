import { schedule, type ScheduledTask } from "node-cron";
import { logger } from "./logger.js";
import { ask } from "./agent.js";
import { loadCrons, type CronJob } from "./tools/builtin/cron.js";
import { loadReminders, saveReminders, type Reminder } from "./tools/builtin/reminder.js";
import { startBot } from "./bot.js";
import { loadConfig } from "./config.js";

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
      // TODO: 之後接 Discord 時，把結果送到指定 channel
      console.log(`[cron:${job.name}] ${response.text}`);
    } catch (err) {
      logger.error({ id: job.id, err }, "cron execution failed");
    }
  });

  activeTasks.set(job.id, task);
}

function loadAndScheduleAll(): void {
  // 先停掉所有現有排程
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
  logger.info({ count, total: jobs.length }, "crons loaded");
  console.log(`Loaded ${count} cron jobs (${jobs.length} total)`);
}

// 定期重新載入 crons.json（每 30 秒），這樣 CLI 建的新排程會被撿起來
function startWatcher(): void {
  setInterval(() => {
    loadAndScheduleAll();
    loadAndScheduleReminders();
  }, 30000);
}

// --- Reminders ---
const activeReminders = new Map<string, NodeJS.Timeout>();

function scheduleReminder(r: Reminder): void {
  if (activeReminders.has(r.id)) {
    clearTimeout(activeReminders.get(r.id)!);
  }
  const delay = new Date(r.triggerAt).getTime() - Date.now();
  if (delay <= 0) {
    // 已過期，直接刪除
    removeReminder(r.id);
    return;
  }
  const timeout = setTimeout(async () => {
    logger.info({ id: r.id, name: r.name, prompt: r.prompt.slice(0, 100) }, "reminder triggered");
    try {
      const response = await ask(r.prompt);
      logger.info({ id: r.id, result: response.text.slice(0, 200) }, "reminder result");
      console.log(`[reminder:${r.name}] ${response.text}`);
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

// --- Journal (每天固定時間寫日記) ---
function scheduleJournal(): void {
  const config = loadConfig();
  if (!config.journal.enabled) return;

  const expr = `${config.journal.minute} ${config.journal.hour} * * *`;
  schedule(expr, () => {
    logger.info({ time: `${config.journal.hour}:${config.journal.minute}` }, "journal triggered");
    const date = new Date().toISOString().split("T")[0];
    const prompt = `現在是 ${date} 的日記整理時間。請做以下事：
1. 用 read_file 讀 workspace/memory/${date}.md
2. 回顧今天所有對話跟互動，補充當下可能沒記下來的東西：有趣的事、討論了什麼、使用者的情緒、你自己的感想
3. 把整理、補充後的完整內容用 write_file 覆蓋回 workspace/memory/${date}.md
`;
    // fire-and-forget：不 await，讓 journal 在背景跑，不阻塞其他排程或訊息處理
    ask(prompt)
      .then(response => logger.info({ date, result: response.text.slice(0, 200) }, "journal done"))
      .catch(err => logger.error({ err, date }, "journal failed"));
  });
  logger.info({ expr }, "journal scheduled");
  console.log(`Journal scheduled at ${config.journal.hour}:${String(config.journal.minute).padStart(2, "0")} daily`);
}

// --- Start ---
console.log("Furet Gateway starting...");
logger.info("gateway start");

loadAndScheduleAll();
loadAndScheduleReminders();
scheduleJournal();
startWatcher();

// Discord bot（有 enabled + token 才啟動）
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

// 保持 process 不退出
process.on("SIGINT", () => {
  console.log("\nGateway stopped.");
  logger.info("gateway stop");
  process.exit(0);
});
