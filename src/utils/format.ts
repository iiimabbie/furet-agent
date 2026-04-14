/**
 * 把 markdown 連結 [text](url) 轉成 Discord 相容格式 [text](<url>)
 * 已經是 [text](<url>) 的不動
 */
export function fixMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\((?!<)(https?:\/\/[^)]+)\)/g, "[$1](<$2>)");
}
