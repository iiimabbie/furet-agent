/**
 * CJK 全文搜尋的分詞前處理。
 *
 * FTS5 預設的 unicode61 tokenizer 不會斷中文——整段中文會變成一個 token，
 * 中文查詢因此永遠搜不到。內建的 trigram tokenizer 也不夠：它需要至少 3 個字元，
 * 而中文最常見的是 2 字詞（記憶、天氣、提醒…）。
 *
 * 解法是自己把中文展開成 bigram 再交給 unicode61：
 *   「今天天氣」→ 「今天 天天 天氣」
 * 寫入索引和查詢都套同一個函式，2 字以上的中文詞就能命中。
 *
 * 非 CJK 片段（英文、數字）原樣保留，讓 unicode61 自己斷詞——
 * 逐字拆會讓 "weather" 變成 "w e a t h e r"，索引膨脹又不精確。
 */

// 中日韓統一表意文字（含擴充 A）、相容表意文字、日文假名
const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;

/**
 * 把文字展開成適合 FTS5 索引/查詢的 token 序列。
 * 中文連續片段展開成 bigram，其他片段原樣保留。
 */
export function toSearchTokens(text: string): string {
  const out: string[] = [];
  let cjk: string[] = [];
  let other: string[] = [];

  const flushCjk = () => {
    if (cjk.length === 0) return;
    if (cjk.length === 1) {
      out.push(cjk[0]);
    } else {
      for (let i = 0; i < cjk.length - 1; i++) out.push(cjk[i] + cjk[i + 1]);
    }
    cjk = [];
  };
  const flushOther = () => {
    if (other.length > 0) {
      out.push(other.join(""));
      other = [];
    }
  };

  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      flushOther();
      cjk.push(ch);
    } else {
      flushCjk();
      other.push(ch);
    }
  }
  flushCjk();
  flushOther();

  return out.join(" ");
}

/**
 * 把使用者查詢轉成 FTS5 MATCH 字串。
 *
 * 冒號會被 FTS5 當成 column filter（"07:27" → column "07"）而拋錯，先換成空白。
 * 其餘的 FTS5 語法字元也一併移除——bigram 展開後這些運算子沒有意義，
 * 留著只會讓查詢語法錯誤。
 */
export function toSearchQuery(query: string): string {
  const cleaned = query.replace(/[:"*(){}^-]/g, " ");
  return toSearchTokens(cleaned).trim();
}

/**
 * 在原文上標記命中的片段。
 *
 * FTS 表存的是 bigram 展開後的文字，highlight() 會回傳展開結果（不能看），
 * 所以改成自己在原文上標。用查詢裡的連續片段去比對，長的優先，避免巢狀標記。
 */
export function highlightMatches(text: string, query: string): string {
  const terms = query
    .replace(/[:"*(){}^-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 0)
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0) return text;

  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  try {
    return text.replace(new RegExp(`(${escaped.join("|")})`, "gi"), "**$1**");
  } catch {
    return text;
  }
}
