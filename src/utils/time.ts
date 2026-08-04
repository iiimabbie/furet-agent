import { loadConfig } from "../config.js";

/**
 * 時間格式化。全部走 config 的 timezone，不寫死任何地區。
 *
 * config.timezone 留空時用系統時區（`Intl` 解析出來的），
 * 這樣別人裝起來預設就是對的，不會拿到台北時間。
 */
function tz(): string {
  const configured = loadConfig().timezone;
  return configured || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

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
