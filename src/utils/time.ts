import { loadConfig } from "../config.js";

/**
 * 解析當前使用的 IANA 時區。全專案共用的單一口徑，不寫死任何地區。
 *
 * 優先序：`config.timezone` → 系統時區（`Intl` 解析出來的）→ 最後才 `UTC`。
 * config.timezone 留空時用系統時區，這樣別人裝起來預設就是對的，不會拿到台北
 * 時間；連系統時區都拿不到才退到 UTC。log 每日分檔（logger.ts）也走這支，
 * 確保分檔日期與記憶檔名／日記日期同一口徑。
 */
export function resolveTimeZone(): string {
  const configured = loadConfig().timezone;
  return configured || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** 內部別名，維持既有呼叫點簡潔。 */
const tz = resolveTimeZone;

/**
 * 對話用的短時間戳：`MM/DD HH:mm`
 *
 * 用 sv-SE locale 是因為它輸出 ISO 風格的 `YYYY-MM-DD HH:mm:ss`，
 * 切出來的位置固定，不會受 locale 影響。
 */
export function stamp(date: Date = new Date()): string {
  return date
    .toLocaleString("sv-SE", { timeZone: tz() })
    .slice(5, 16)
    .replace("-", "/");
}

/** 當地日期 `YYYY-MM-DD`（記憶檔名、日記日期用） */
export function today(date: Date = new Date()): string {
  return date.toLocaleString("sv-SE", { timeZone: tz() }).slice(0, 10);
}

/** 當地時間 `HH:mm:ss`（記憶條目用） */
export function clockTime(date: Date = new Date()): string {
  return date.toLocaleString("sv-SE", { timeZone: tz() }).slice(11, 19);
}

/** 完整時間 + 時區名，給 system prompt 用 */
export function nowWithZone(date: Date = new Date()): string {
  const zone = tz();
  return `${date.toLocaleString("sv-SE", { timeZone: zone })} (${zone})`;
}
