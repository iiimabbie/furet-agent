import pino from "pino";
import pretty from "pino-pretty";
import { LOGS_DIR } from "./paths.js";
import { resolveTimeZone } from "./utils/time.js";
import { createDailyFileStream } from "./dailyFileStream.js";

/**
 * Preserve the full Error chain in structured logs.
 *
 * Error.message, Error.stack, and Error.cause are non-enumerable, so logging an
 * Error as a plain object can silently drop the transport error details we need
 * for incidents such as `TypeError: fetch failed`.
 */
function serializeError(error: unknown, seen = new WeakSet<object>()): unknown {
  if (!(error instanceof Error)) return error;
  if (seen.has(error)) return { type: error.name, message: error.message, circular: true };
  seen.add(error);

  const serialized: Record<string, unknown> = {
    type: error.name,
    message: error.message,
    stack: error.stack,
  };

  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") continue;
    serialized[key] = (error as unknown as Record<string, unknown>)[key];
  }

  if (error.cause !== undefined) {
    serialized.cause = serializeError(error.cause, seen);
  }

  return serialized;
}

/**
 * Log 依「本地日期」每天分檔：`logs/furet-YYYY-MM-DD.log`。
 *
 * pino-pretty 在主執行緒把每筆 log 格式化成人類可讀的
 * `YYYY-MM-DD HH:mm:ss` 單行格式，再寫入 daily file stream；後者依當下本地
 * 日期挑檔名，跨午夜時自動換檔、以 append 開啟，不需重啟程序。
 *
 * 分檔用的時區走 `resolveTimeZone()`——與記憶檔名／日記日期／system prompt
 * 同一口徑：優先 `config.timezone`，未設定或空白時退到系統 IANA 時區，最後才
 * UTC，不硬編碼任何地區，避免文件宣稱與實作不一致。
 */
const timeZone = resolveTimeZone();

const prettyStream = pretty({
  destination: createDailyFileStream({ dir: LOGS_DIR, prefix: "furet", timeZone }),
  colorize: false,
  translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
});

// daily file stream 會把底層 fs 的 open/write 錯誤轉送成 "error"。這裡掛一個
// 最終保險 listener：真的寫檔失敗時不讓它變成 uncaught exception，而是印到
// stderr（此時 logger 本身可能已無法寫檔）。
prettyStream.on("error", (err) => {
  process.stderr.write(`[logger] daily file stream error: ${String(err)}\n`);
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "debug",
    serializers: { err: serializeError },
  },
  prettyStream,
);
