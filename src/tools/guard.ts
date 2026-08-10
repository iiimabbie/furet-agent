import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { WORKSPACE_DIR, WORKSPACE_CONFIG_DIR, SESSIONS_DIR } from "../paths.js";
import { getTrigger } from "./context.js";

/**
 * 非 owner（`trigger === "discord-other"`）的檔案讀取邊界。
 *
 * registry.ts 的 OWNER_ONLY_TOOLS 是「整個工具擋掉」，但 read_file 不能整個擋：
 * AGENT.md 的開場流程每次都要讀當天的 daily memory，skill 也只給路徑不給內容
 * （prompt.ts:61），全鎖等於陌生人一來就失去上下文、skill 全失效。
 *
 * 所以這裡改成擋路徑而不是擋工具——workspace 內照讀，workspace 外一律拒絕。
 * 這道線擋掉的是 config.yaml（含 Discord token）跟整個 src/。
 *
 * 注意：這擋得住直接讀檔，擋不住 memory_search 之類的語意搜尋撈出日記內容。
 * 那是另一層的取捨，目前刻意不擋（記錄的都是公開頻道對話）。
 */

/** workspace 底下另外挖掉的子目錄：憑證、資料庫、其他人的對話紀錄 */
const DENIED_SUBDIRS = [WORKSPACE_CONFIG_DIR, SESSIONS_DIR];

const DENY_MESSAGE =
  "⚠️ PERMISSION DENIED: This path is outside the area readable when responding to a non-owner user. " +
  "Do NOT retry this path or attempt another route to the same file for this request.";

/** WORKSPACE_DIR 自己可能是 symlink，先解成實體路徑，才比得過 realpath 過的目標 */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // 檔案還不存在（write 的情況）就退回字面路徑，`..` 已由 resolve 正規化掉
    return path;
  }
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/**
 * 回傳拒絕訊息，或 null 代表放行。
 *
 * 走 realpath 是為了讓 workspace 內指向外部的 symlink 也被解出去、擋下來——
 * 只比對字面路徑的話，一條 symlink 就能把整個邊界繞過。
 */
export function checkFileAccess(path: string): string | null {
  if (getTrigger() !== "discord-other") return null;

  const target = realOrSelf(resolve(path));
  const root = realOrSelf(WORKSPACE_DIR);

  if (!within(target, root)) return DENY_MESSAGE;
  if (DENIED_SUBDIRS.some(dir => within(target, realOrSelf(dir)))) return DENY_MESSAGE;

  return null;
}
