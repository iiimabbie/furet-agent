/**
 * 共用的靜默回覆哨符判定。一般 Discord 對話（`bot.ts`）與排程 / 提醒（`gateway.ts`）
 * 都 import 這裡，確保「什麼算靜默」由單一處定義，不再各自判斷。
 *
 * Canonical token 為 `[no_reply]`。判定採「trim 後整則相等、大小寫不敏感」而非
 * `includes`——後者會把「我先不回好了，[no_reply]」這種夾帶實質內容的訊息整個誤吞。
 * 因此哨符只在整則就是哨符本身時才生效。
 *
 * 為了相容早期排程端用過的 `[noreply]`（無底線），helper 明確支援這個 legacy alias；
 * 但 prompt 與文件一律只推 canonical 的 `[no_reply]`。
 */

/** 對外的正規哨符——prompt 與文件都用這個。 */
export const NO_REPLY_TOKEN = "[no_reply]";

/** trim + lower-case 後允許整則相等的哨符集合（含 legacy alias）。 */
const ACCEPTED_SENTINELS = new Set([NO_REPLY_TOKEN, "[noreply]"]);

/**
 * 模型「最終」文字回覆整則就是靜默哨符時回 true（trim + 大小寫不敏感）。
 * 空字串 / 空白 / null / undefined 一律 false（那些交給呼叫端既有的空文字分支處理）。
 */
export function isNoReplySentinel(text: string | undefined | null): boolean {
  return ACCEPTED_SENTINELS.has((text ?? "").trim().toLowerCase());
}
