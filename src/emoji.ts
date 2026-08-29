/**
 * Application Emoji 核心（開源通用功能）。
 *
 * Discord Application 可以擁有一組專屬的 emoji（`client.application.emojis`），
 * 不隸屬任何 guild，只要 bot 在場就能在自己的訊息裡使用。這個模組：
 *
 *   1. 在 Discord ready 時把 Application 自己擁有的 emoji 抓進記憶體快取
 *      （name → id / animated），不寫死任何使用者的 emoji ID、名稱或圖片。
 *   2. 產生一段精簡的可用 emoji 清單，注入 Discord request 的 system prompt，
 *      讓模型知道有哪些可用、以及輸出語法（`:name:`）。無 emoji 時不產生任何區塊。
 *   3. 在 Discord 送出前，把模型以穩定語法 `:name:` 引用的 emoji 解析成
 *      Discord 接受的 `<:name:id>` / `<a:name:id>`。名稱不存在時保留原文，不捏造 ID。
 *      不解析 fenced code block / inline code span 內的文字。
 *
 * 失敗降級：同步失敗只記錄原始 Error 並安全退回「無 emoji」狀態，
 * 絕不讓 bot 啟動失敗，也不阻擋任何訊息送出。
 *
 * 每顆 emoji 的語意、適用場合與使用頻率屬於可選的部署端個人化設定，
 * 不由此核心模組保存，也不在公開 repository 寫死私人資料。
 */

import type { Client } from "discord.js";
import { logger } from "./logger.js";

/** 記憶體快取的單顆 Application Emoji。 */
export interface CachedEmoji {
  name: string;
  id: string;
  animated: boolean;
}

/**
 * 快取狀態。`entries` 以 emoji 名稱（原樣，大小寫敏感）為 key。
 * `fetchedAt` 為 0 代表「尚未成功同步過」。
 */
interface EmojiCacheState {
  entries: Map<string, CachedEmoji>;
  fetchedAt: number;
}

const cache: EmojiCacheState = {
  entries: new Map(),
  fetchedAt: 0,
};

/**
 * Lazy refresh 的存活時間。同步只發生在：
 *   - Discord ready 啟動時的一次強制同步；
 *   - 之後任何解析／組 prompt 前，若距上次成功同步超過 TTL，觸發一次背景刷新
 *     （非阻塞：本輪先用既有快取，刷新結果供下一輪使用）。
 * 這樣新增／刪除 emoji 後最多一個 TTL 就會反映，且不需要額外的 slash command 或 UI。
 */
export const EMOJI_CACHE_TTL_MS = 10 * 60 * 1000;

/** 記住 client 供 lazy refresh 使用；ready 時由 bot 設定。 */
let boundClient: Client | null = null;

/** 避免並發刷新互相覆寫的 in-flight 旗標。 */
let refreshInFlight: Promise<void> | null = null;

/**
 * 從 Discord API 抓取 Application 自己擁有的 emoji，重建記憶體快取。
 *
 * 這是唯一的資料來源：不讀取任何寫死的清單。任何錯誤都被吞掉並記錄原始 Error，
 * 呼叫端（ready handler）永遠不會因此拋出。回傳是否成功，供呼叫端記錄用。
 */
export async function syncApplicationEmojis(client: Client): Promise<boolean> {
  boundClient = client;
  try {
    const application = client.application;
    if (!application) {
      logger.warn("emoji sync skipped: client.application not available");
      return false;
    }
    // fetch() 不帶 id → 回傳整個 Collection，並更新 manager 內部快取。
    const collection = await application.emojis.fetch();
    const entries = new Map<string, CachedEmoji>();
    for (const emoji of collection.values()) {
      if (!emoji.name || !emoji.id) continue;
      entries.set(emoji.name, {
        name: emoji.name,
        id: emoji.id,
        animated: Boolean(emoji.animated),
      });
    }
    cache.entries = entries;
    cache.fetchedAt = Date.now();
    logger.info({ count: entries.size }, "application emojis synced");
    return true;
  } catch (err) {
    // 保留原始 Error（含 cause / code），不要只留 message，才看得到真正原因。
    logger.error({ err }, "application emoji sync failed; falling back to no-emoji");
    return false;
  }
}

/**
 * 若距上次成功同步已超過 TTL，觸發一次非阻塞背景刷新。
 * 從未成功同步過（fetchedAt === 0）時不主動刷新——啟動同步負責首載，
 * 這裡只負責「已載入後的低成本更新」，避免每次解析都打 API。
 */
function maybeRefresh(): void {
  if (cache.fetchedAt === 0) return;
  if (!boundClient) return;
  if (refreshInFlight) return;
  if (Date.now() - cache.fetchedAt < EMOJI_CACHE_TTL_MS) return;
  const client = boundClient;
  refreshInFlight = syncApplicationEmojis(client)
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => { refreshInFlight = null; });
}

/** 回傳目前快取的所有 emoji（複本），依名稱排序。供 prompt 組裝與測試用。 */
export function getEmojiCatalog(): CachedEmoji[] {
  maybeRefresh();
  return [...cache.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 測試用：直接注入快取狀態，不打 Discord API。 */
export function __setEmojiCacheForTest(list: CachedEmoji[], fetchedAt = Date.now()): void {
  cache.entries = new Map(list.map(e => [e.name, e]));
  cache.fetchedAt = fetchedAt;
  boundClient = null;
  refreshInFlight = null;
}

/** 測試用：清空快取回到「未同步」狀態。 */
export function __clearEmojiCacheForTest(): void {
  cache.entries = new Map();
  cache.fetchedAt = 0;
  boundClient = null;
  refreshInFlight = null;
}

/**
 * 組出注入 system prompt 的 emoji 區塊。無可用 emoji 時回空字串——
 * 不加空泛區塊，也不浪費 token。
 *
 * 只放必要資訊：可用名稱清單 + 一句語法說明。刻意不逐顆描述語意（那屬個人化擴充），
 * 控制 token 成本。
 */
export function buildEmojiPromptSection(): string {
  const catalog = getEmojiCatalog();
  if (catalog.length === 0) return "";
  const names = catalog.map(e => `:${e.name}:`).join(" ");
  return `<application-emojis>
You have these custom application emojis available: ${names}
To use one, write its name wrapped in colons exactly as listed (e.g. \`:${catalog[0].name}:\`); it is converted to the real Discord emoji on send. A name not in the list is left as plain text — never invent one. Do not overuse them.
</application-emojis>`;
}

// --- Resolution on send ---

/**
 * 掃描一段文字，找出所有「不在 code fence / inline code span 內」的區間，
 * 回傳這些安全區間的 [start, end) 索引。fenced block（``` 或 ~~~）與 inline
 * span（`` ` ``）內的內容一律視為不可替換，避免範例、log、程式碼裡的 `:name:`
 * 被誤換。
 */
function findReplaceableRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = text.split("\n");
  let inFence = false;
  let fenceMarker = "";
  let offset = 0;

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length; // 不含換行
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      const rest = fenceMatch[2];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length && rest.trim() === "") {
        inFence = false;
        fenceMarker = "";
      }
      // fence 標記行本身不參與替換
      offset = lineEnd + 1;
      continue;
    }

    if (inFence) {
      offset = lineEnd + 1;
      continue;
    }

    // 非 fence 行：再切掉 inline code span（成對的 backtick）
    appendLineRangesExcludingInlineCode(line, lineStart, ranges);
    offset = lineEnd + 1;
  }

  return ranges;
}

/**
 * 對單一（非 fence）行，將 inline code span 排除後，把可替換的區間推入 `ranges`。
 * inline code 以「相同數量的 backtick 成對」界定（如 `` `x` ``、`` ``x`` ``）；
 * 沒有配對的孤立 backtick 不啟動 code span，維持整行可替換。
 */
function appendLineRangesExcludingInlineCode(line: string, lineStart: number, ranges: Array<[number, number]>): void {
  const tickRun = /`+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  const openers: Array<{ index: number; len: number }> = [];

  // 先收集所有 backtick run
  const runs: Array<{ index: number; len: number }> = [];
  while ((match = tickRun.exec(line)) !== null) {
    runs.push({ index: match.index, len: match[0].length });
  }

  // 用 stack 配對出 code span 的覆蓋區間（[spanStart, spanEnd)）
  const spans: Array<[number, number]> = [];
  for (const run of runs) {
    const openIdx = openers.findIndex(o => o.len === run.len);
    if (openIdx === -1) {
      openers.push(run);
    } else {
      const opener = openers[openIdx];
      spans.push([opener.index, run.index + run.len]);
      openers.length = 0; // 一組成對後清空，避免跨 span 誤配
    }
  }

  // 依 span 把行切成可替換片段
  spans.sort((a, b) => a[0] - b[0]);
  for (const [spanStart, spanEnd] of spans) {
    if (spanStart > cursor) ranges.push([lineStart + cursor, lineStart + spanStart]);
    cursor = Math.max(cursor, spanEnd);
  }
  if (cursor < line.length) ranges.push([lineStart + cursor, lineStart + line.length]);
}

/** 名稱合法字元：Discord emoji 名稱是 2–32 字元的 `[A-Za-z0-9_]`。 */
const EMOJI_REF = /:([A-Za-z0-9_]{2,32}):/g;

/**
 * 把文字中以 `:name:` 引用、且對應到已快取 Application Emoji 的部分，
 * 替換成 Discord 接受的 `<:name:id>` / `<a:name:id>`。
 *
 * - 只在 code fence / inline code span 之外替換。
 * - 名稱不在快取時原樣保留（可讀降級），不捏造 ID。
 * - 快取為空時直接回原文，零成本。
 */
export function resolveEmojiMarkup(text: string): string {
  if (!text) return text;
  const catalog = cache.entries;
  maybeRefresh();
  if (catalog.size === 0) return text;

  const ranges = findReplaceableRanges(text);
  if (ranges.length === 0) return text;

  // 由後往前替換，避免前面替換造成後面索引位移。
  let result = text;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [start, end] = ranges[i];
    const segment = result.slice(start, end);
    const replaced = segment.replace(EMOJI_REF, (whole, name: string) => {
      const emoji = catalog.get(name);
      if (!emoji) return whole; // 不存在 → 保留原文，不捏造
      return emoji.animated ? `<a:${name}:${emoji.id}>` : `<:${name}:${emoji.id}>`;
    });
    result = result.slice(0, start) + replaced + result.slice(end);
  }
  return result;
}
