import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { configureInitialDiscordOwner, loadConfig } from "./config.js";

const DISCORD_ID = /^\d{17,20}$/;

async function askForDiscordId(rl: ReturnType<typeof createInterface>, question: string, required: boolean): Promise<string> {
  while (true) {
    const value = (await rl.question(question)).trim();
    if (!value && !required) return "";
    if (DISCORD_ID.test(value)) return value;
    console.log("Discord ID 應該是 17–20 位數字。請在 Discord 開啟 Developer Mode，右鍵使用者或頻道後選 Copy ID。");
  }
}

const config = loadConfig();
const rl = createInterface({ input, output });
try {
  if (config.discord.owner_id) {
    const answer = (await rl.question(`目前已有 Discord 設定（owner_id: ${config.discord.owner_id}）。確定要重新設定嗎？Y/n `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("保留現有設定，沒有變更。");
      process.exit(0);
    }
    console.log("");
  }

  console.log("Furet Discord setup\n");
  console.log("這個步驟只設定 Discord 的基本存取範圍；助理的稱呼與人格會在 owner 第一次於 Discord 對話時再詢問。\n");
  const ownerId = await askForDiscordId(rl, "你的 Discord user ID：", true);
  const channelId = await askForDiscordId(rl, "第一個要允許使用的 Discord channel ID（可留白）：", false);
  configureInitialDiscordOwner(ownerId, channelId || undefined);
  console.log("\n已寫入 config.yaml：");
  console.log(`- discord.owner_id: ${ownerId}`);
  console.log(channelId
    ? `- discord.allowed_channels: [${channelId}]`
    : "- discord.allowed_channels: []（暫不限制頻道）");
  console.log("\n現在可啟動或繼續使用 gateway；owner 第一次在 Discord 觸發 bot 時，會開始設定稱呼與人格。");
} finally {
  rl.close();
}
