import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARCHIVE_DIR, SESSIONS_DIR, ATTACHMENTS_DIR } from "../../paths.js";
import { getDb } from "../../db.js";
import { logger } from "../../logger.js";
import type { Tool } from "../../types.js";

// --- Stats collector ---

interface DashboardStats {
  sessions: number;
  messages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number;
  /** date string YYYY-MM-DD → message count */
  dailyActivity: Map<string, number>;
}

/** Parse archive time field "MM/DD HH:mm" into { month, day, hour } relative to current year */
function parseTime(time: string): { date: string; hour: number } | null {
  const m = time.match(/^(\d{2})\/(\d{2})\s+(\d{2}):\d{2}$/);
  if (!m) return null;
  const month = m[1];
  const day = m[2];
  const hour = parseInt(m[3], 10);
  // Assume current year — archives don't span years in practice
  const year = new Date().getFullYear();
  return { date: `${year}-${month}-${day}`, hour };
}

function computeStreaks(dates: string[]): { current: number; longest: number } {
  if (dates.length === 0) return { current: 0, longest: 0 };
  const sorted = [...dates].sort();
  let longest = 1;
  let current = 1;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]);
    const curr = new Date(sorted[i]);
    const diffDays = (curr.getTime() - prev.getTime()) / 86400000;
    if (diffDays === 1) {
      current++;
    } else if (diffDays > 1) {
      current = 1;
    }
    longest = Math.max(longest, current);
  }

  // current streak: count back from today/yesterday
  const last = sorted[sorted.length - 1];
  if (last !== today && last !== yesterday) {
    current = 0;
  } else {
    // recount from end
    current = 1;
    for (let i = sorted.length - 2; i >= 0; i--) {
      const prev = new Date(sorted[i]);
      const curr = new Date(sorted[i + 1]);
      const diffDays = (curr.getTime() - prev.getTime()) / 86400000;
      if (diffDays === 1) current++;
      else break;
    }
  }

  return { current, longest };
}

export function collectStats(): DashboardStats {
  // 1. Count sessions & tokens from archive JSON files
  const archiveFiles = readdirSync(ARCHIVE_DIR).filter(f => f.endsWith(".json"));
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const file of archiveFiles) {
    try {
      const raw = JSON.parse(readFileSync(resolve(ARCHIVE_DIR, file), "utf-8"));
      if (raw.usage) {
        totalInputTokens += raw.usage.inputTokens ?? 0;
        totalOutputTokens += raw.usage.outputTokens ?? 0;
      }
    } catch { /* skip corrupted files */ }
  }

  // Add active sessions' usage
  const activeFiles = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
  for (const file of activeFiles) {
    try {
      const raw = JSON.parse(readFileSync(resolve(SESSIONS_DIR, file), "utf-8"));
      if (raw.usage) {
        totalInputTokens += raw.usage.inputTokens ?? 0;
        totalOutputTokens += raw.usage.outputTokens ?? 0;
      }
    } catch { /* skip */ }
  }

  // 2. Messages, daily activity, peak hour from DB
  const db = getDb();
  const rows = db.prepare("SELECT time FROM session_archive WHERE time IS NOT NULL").all() as { time: string }[];

  const dailyActivity = new Map<string, number>();
  const hourCounts = new Array(24).fill(0);

  for (const row of rows) {
    const parsed = parseTime(row.time);
    if (!parsed) continue;
    dailyActivity.set(parsed.date, (dailyActivity.get(parsed.date) ?? 0) + 1);
    hourCounts[parsed.hour]++;
  }

  // Also count messages from active sessions
  let activeMessages = 0;
  for (const file of activeFiles) {
    try {
      const raw = JSON.parse(readFileSync(resolve(SESSIONS_DIR, file), "utf-8"));
      const msgs = raw.messages ?? [];
      activeMessages += msgs.length;
      for (const m of msgs) {
        if (!m.time) continue;
        const parsed = parseTime(m.time);
        if (!parsed) continue;
        dailyActivity.set(parsed.date, (dailyActivity.get(parsed.date) ?? 0) + 1);
        hourCounts[parsed.hour]++;
      }
    } catch { /* skip */ }
  }

  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  const dates = [...dailyActivity.keys()];
  const { current: currentStreak, longest: longestStreak } = computeStreaks(dates);

  // Unique session count = archive files + active session files
  const archiveSessionIds = new Set(archiveFiles.map(f => f.replace(/-\d{4}-\d{2}-\d{2}T.*$/, "")));
  const sessions = archiveSessionIds.size + activeFiles.length;

  return {
    sessions,
    messages: rows.length + activeMessages,
    totalInputTokens,
    totalOutputTokens,
    activeDays: dates.length,
    currentStreak,
    longestStreak,
    peakHour,
    dailyActivity,
  };
}

// --- HTML renderer ---

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function generateHeatmapData(dailyActivity: Map<string, number>): { date: string; count: number }[] {
  // Last 10 weeks (70 days)
  const days: { date: string; count: number }[] = [];
  const now = new Date();
  for (let i = 69; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    days.push({ date: dateStr, count: dailyActivity.get(dateStr) ?? 0 });
  }
  return days;
}

function heatmapColor(count: number, max: number): string {
  if (count === 0) return "#ebedf0";
  const ratio = count / max;
  if (ratio <= 0.25) return "#c6d9f1";
  if (ratio <= 0.5) return "#85b1e0";
  if (ratio <= 0.75) return "#4a8ccf";
  return "#2563eb";
}

export function renderDashboardHTML(stats: DashboardStats): string {
  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const heatmapData = generateHeatmapData(stats.dailyActivity);
  const maxCount = Math.max(1, ...heatmapData.map(d => d.count));

  // Build heatmap grid: 7 rows (Mon-Sun) × 10 columns (weeks)
  // Pad start so last day is today
  const cells: string[] = [];
  const cellSize = 14;
  const gap = 3;

  for (let i = 0; i < heatmapData.length; i++) {
    const d = heatmapData[i];
    const dayOfWeek = new Date(d.date).getDay(); // 0=Sun
    const col = Math.floor(i / 7);
    const row = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Mon=0, Sun=6
    const x = col * (cellSize + gap);
    const y = row * (cellSize + gap);
    const color = heatmapColor(d.count, maxCount);
    cells.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="3" fill="${color}"><title>${d.date}: ${d.count} msgs</title></rect>`);
  }

  const svgWidth = 10 * (cellSize + gap);
  const svgHeight = 7 * (cellSize + gap);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f5f5;
    padding: 24px;
    width: 560px;
  }
  .card {
    background: white;
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .title {
    font-size: 16px;
    font-weight: 700;
    color: #333;
    margin-bottom: 18px;
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 24px;
  }
  .stat-box {
    background: #f8f9fa;
    border-radius: 10px;
    padding: 12px;
  }
  .stat-label {
    font-size: 11px;
    color: #888;
    margin-bottom: 4px;
    font-weight: 500;
  }
  .stat-value {
    font-size: 22px;
    font-weight: 700;
    color: #222;
  }
  .stat-value.small {
    font-size: 18px;
  }
  .heatmap {
    display: flex;
    justify-content: center;
    margin-top: 8px;
  }
  .footer {
    text-align: center;
    margin-top: 16px;
    font-size: 11px;
    color: #bbb;
  }
</style>
</head>
<body>
<div class="card">
  <div class="title">Furet Usage</div>
  <div class="stats-grid">
    <div class="stat-box">
      <div class="stat-label">Sessions</div>
      <div class="stat-value">${stats.sessions}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Messages</div>
      <div class="stat-value">${stats.messages.toLocaleString()}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Total tokens</div>
      <div class="stat-value">${formatTokens(totalTokens)}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Active days</div>
      <div class="stat-value">${stats.activeDays}</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Current streak</div>
      <div class="stat-value small">${stats.currentStreak}d</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Longest streak</div>
      <div class="stat-value small">${stats.longestStreak}d</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Peak hour</div>
      <div class="stat-value small">${stats.peakHour}:00</div>
    </div>
  </div>
  <div class="heatmap">
    <svg width="${svgWidth}" height="${svgHeight}">
      ${cells.join("\n      ")}
    </svg>
  </div>
</div>
</body>
</html>`;
}

// --- Puppeteer screenshot ---

export async function renderDashboardImage(): Promise<Buffer> {
  const stats = collectStats();
  const html = renderDashboardHTML(stats);

  // Dynamic import to avoid loading puppeteer at startup
  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 560, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "load" });

    // Clip to card bounds
    const cardBox = await page.$eval(".card", (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

    const buf = await page.screenshot({
      type: "png",
      clip: {
        x: cardBox.x - 8,
        y: cardBox.y - 8,
        width: cardBox.width + 16,
        height: cardBox.height + 16,
      },
    });

    return Buffer.from(buf);
  } finally {
    await browser.close();
  }
}

// --- Tool definition ---

export const usageDashboard: Tool = {
  name: "usage_dashboard",
  description: "Generate a visual usage dashboard image showing Furet's session stats, token usage, streaks, and activity heatmap. Returns the image as a Discord attachment.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  execute: async () => {
    try {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const imgBuf = await renderDashboardImage();
      mkdirSync(ATTACHMENTS_DIR, { recursive: true });
      const outPath = resolve(ATTACHMENTS_DIR, "dashboard.png");
      writeFileSync(outPath, imgBuf);
      // Use the attachment context to attach to reply
      const { queueAttachment } = await import("../context.js");
      queueAttachment(outPath);
      return "Dashboard image generated and attached.";
    } catch (err) {
      logger.error({ err: (err as Error).message, stack: (err as Error).stack }, "dashboard generation failed");
      return `Dashboard generation failed: ${(err as Error).message}`;
    }
  },
};
