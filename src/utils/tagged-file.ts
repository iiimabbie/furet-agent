/**
 * workspace 的 md 檔用 XML tag 標出 system prompt 裡的區塊邊界
 * （`<memory>`、`<people>`…）。
 *
 * 附加內容時必須先把包裝剝掉、接完再包回去——直接往檔案尾端接會落到
 * 結束標籤外面，那段內容就會跑出區塊。
 */

/** 去掉外層包裝標籤，回傳純內容 */
export function stripTag(content: string, tag: string): string {
  return content
    .replace(new RegExp(`^\\s*<${tag}>`), "")
    .replace(new RegExp(`</${tag}>\\s*$`), "")
    .trim();
}

/** 包上外層標籤。已經有的話不重複包。 */
export function wrapTag(body: string, tag: string): string {
  const inner = stripTag(body, tag);
  return `<${tag}>\n\n${inner}\n\n</${tag}>\n`;
}

/** 在標籤內部的尾端附加內容 */
export function appendInsideTag(current: string, addition: string, tag: string): string {
  const body = stripTag(current, tag);
  const merged = body ? `${body}\n\n${addition.trim()}` : addition.trim();
  return wrapTag(merged, tag);
}
