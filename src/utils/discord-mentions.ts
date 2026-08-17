import type { Client, Guild } from "discord.js";

/** username 與暱稱的分隔符 */
export const NAME_SEP = "｜";

/**
 * 把 `<@userID>` 轉成 `<@userID>(username｜暱稱)`。
 *
 * 兩者都要：username 全域唯一且穩定，是身分依據；暱稱可改、跨伺服器不同，
 * 只能用於稱呼。暱稱為寫入當下的快照，事後變更不影響已存訊息。
 * 稱呼的最終依據是 PEOPLE.md，暱稱僅為預設值。
 */
export async function normalizeMentions(
  text: string,
  client: Client,
  guild?: Guild | null,
): Promise<string> {
  const matches = [...text.matchAll(/<@!?(\d+)>/g)];
  if (matches.length === 0) return text;

  const botId = client.user?.id ?? "";
  const nameMap = new Map<string, string>();

  for (const m of matches) {
    const id = m[1];
    if (nameMap.has(id)) continue;
    try {
      const user = id === botId && client.user ? client.user : await client.users.fetch(id);
      const nick = guild ? await guild.members.fetch(id).then(mem => mem.displayName).catch(() => null) : null;
      nameMap.set(id, formatName(user.username, nick));
    } catch { nameMap.set(id, "unknown"); }
  }
  return text.replace(/<@!?(\d+)>/g, (orig, id) => `${orig}(${nameMap.get(id) ?? "unknown"})`);
}

/** `username｜暱稱`；暱稱缺少或與 username 相同時只留 username */
export function formatName(username: string, nickname?: string | null): string {
  return nickname && nickname !== username ? `${username}${NAME_SEP}${nickname}` : username;
}
