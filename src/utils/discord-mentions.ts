import type { Client, Guild } from "discord.js";

/**
 * 把 `<@userID>` 轉成 `<@userID>(nickname)`，方便 agent 讀取對話時知道是誰。
 * Guild 情境：優先取 displayName；DM / 無 guild：退化到 username。
 * Bot 自己用 client.user 或 guild.me 的 displayName。
 */
export async function normalizeMentions(
  text: string,
  client: Client,
  guild?: Guild | null,
): Promise<string> {
  const matches = [...text.matchAll(/<@!?(\d+)>/g)];
  if (matches.length === 0) return text;

  const botId = client.user?.id ?? "";
  const botName = guild?.members.me?.displayName ?? client.user?.username ?? "bot";

  const nameMap = new Map<string, string>();
  for (const m of matches) {
    const id = m[1];
    if (nameMap.has(id)) continue;
    if (id === botId) { nameMap.set(id, botName); continue; }
    try {
      if (guild) {
        const member = await guild.members.fetch(id);
        nameMap.set(id, member.displayName);
      } else {
        const user = await client.users.fetch(id);
        nameMap.set(id, user.username);
      }
    } catch { nameMap.set(id, "unknown"); }
  }
  return text.replace(/<@!?(\d+)>/g, (orig, id) => `${orig}(${nameMap.get(id) ?? "unknown"})`);
}
