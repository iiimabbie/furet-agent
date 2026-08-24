import { Writable } from "node:stream";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";

/**
 * 依「本地日期」每天分檔的 log 寫入流。
 *
 * 為什麼要自己做：pino-pretty 的 `destination` 只吃固定路徑字串，無法在
 * 跨午夜時自動換檔。這裡改用一個 Writable 當 destination —— pino-pretty 會把
 * 每一行格式化好（人類可讀的 `YYYY-MM-DD HH:mm:ss`）後寫進來，我們在寫入前
 * 依當下本地日期挑檔名，跨日就無縫切到新的日期檔，不需重啟程序。
 *
 * 檔案一律以 append 開啟（flags: "a"），啟動時不會覆蓋既有的當日 log。
 *
 * 錯誤處理：底層 fs WriteStream 可能在 open 階段（權限、路徑不存在）或寫入時
 * 拋錯，並以 `error` 事件送出。若沒有人監聽，Node 會把它升級成 uncaught
 * exception 直接讓程序 crash。這裡的策略：
 *   - 進行中的寫入若遇錯，透過該次 `write()` 的 callback(err) 回報，Node 會據此
 *     destroy 外層 Writable 並對消費者 emit "error"（標準 stream 語意）。
 *   - 非寫入期間才浮現的錯誤（例如非同步 open 失敗、閒置時底層出錯），由持久的
 *     `error` listener 轉送成 `outer.destroy(err)`。
 * 兩條路徑用 settled 旗標互斥，保證任何一次錯誤只會觸發一次傳播、callback 不重複。
 */
export interface DailyFileStreamOptions {
  /** log 目錄 */
  dir: string;
  /** 檔名前綴，實際檔名為 `${prefix}-YYYY-MM-DD.log` */
  prefix?: string;
  /** 用來取得本地日期的 IANA 時區，預設 Asia/Taipei */
  timeZone?: string;
}

/** 以指定時區把時間點格式化成 `YYYY-MM-DD`。 */
function localDate(timeZone: string, now = new Date()): string {
  // en-CA 的日期格式天生就是 YYYY-MM-DD，最省事。
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 一條底層日期檔 stream，連同它「當下有沒有進行中的 write」的狀態。 */
interface DatedStream {
  date: string;
  stream: WriteStream;
  /** 目前這條 stream 有無 in-flight write 的 error 由該次 write callback 處理。 */
  writeInFlight: boolean;
}

export function createDailyFileStream(options: DailyFileStreamOptions): Writable {
  const { dir, prefix = "furet", timeZone = "Asia/Taipei" } = options;

  mkdirSync(dir, { recursive: true });

  let current: DatedStream | null = null;
  // 外層 Writable：by ref 存取，才能從持久 error listener 呼叫 destroy()。
  let outer: Writable;

  function openStream(date: string): DatedStream {
    const stream = createWriteStream(resolve(dir, `${prefix}-${date}.log`), {
      flags: "a", // append：啟動時不覆蓋既有當日檔
    });
    const dated: DatedStream = { date, stream, writeInFlight: false };
    // 非寫入期間浮現的底層錯誤（open 失敗、閒置出錯）在這裡轉送；in-flight
    // 的寫入錯誤交給 write() callback，這裡就略過避免雙重傳播。
    stream.on("error", (err) => {
      if (dated.writeInFlight) return;
      // 換掉的舊 stream 出錯不該再影響外層（新檔已在寫）。
      if (current !== dated) return;
      outer.destroy(err);
    });
    return dated;
  }

  function streamFor(date: string): DatedStream {
    if (current === null || date !== current.date) {
      // 跨午夜換檔：關掉舊 stream。舊 stream 之後若 emit error，因 current 已
      // 換人，其 listener 會自行略過，不干擾新檔。
      current?.stream.end();
      current = openStream(date);
    }
    return current;
  }

  outer = new Writable({
    write(chunk, _encoding, callback) {
      let dated: DatedStream;
      try {
        dated = streamFor(localDate(timeZone));
      } catch (err) {
        // 換檔過程同步拋錯（罕見），直接回報給這次寫入。
        callback(err as Error);
        return;
      }

      // callback 只呼叫一次。in-flight 期間把錯誤導向 write callback，
      // 避免持久 error listener 同時再 destroy 一次。
      let settled = false;
      dated.writeInFlight = true;
      dated.stream.write(chunk, (err) => {
        if (settled) return;
        settled = true;
        dated.writeInFlight = false;
        callback(err ?? undefined);
      });
    },
    final(callback) {
      if (current) {
        current.stream.end(() => callback());
      } else {
        callback();
      }
    },
  });

  return outer;
}
