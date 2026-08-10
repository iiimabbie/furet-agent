import type { Tool } from "../types.js";
import { logger } from "../logger.js";
import { loadConfig } from "../config.js";
export { setTrigger, getTrigger } from "./context.js";
import { getTrigger, getUserId } from "./context.js";

const OWNER_ONLY_TOOLS = new Set([
  // write_file 沒有路徑邊界，寫得進 src/ 就等於繞過 bash 的 owner-only。
  // 非 owner 也沒有寫任意檔案的正當理由——記人記事走 people_* / memory_*，
  // 那些工具的落點寫死在 paths.ts。read_file 刻意不列在這裡：整個擋掉會讓
  // 陌生人一互動就讀不到當天 daily memory 與 skill，改由 guard.ts 擋路徑。
  "write_file",
  "memory_replace", "memory_remove",
  // people_add / people_update 刻意不列 owner-only：agent 要能在非 owner 講話時
  // 記下對方是誰，鎖起來等於永遠記不了非 owner。真正的權限判定看 config.discord.owner_id，
  // 不是 PEOPLE.md，所以寫入這個檔案不會造成提權。刪除是破壞性的，維持 owner-only。
  "people_remove",
  "cron_create", "cron_delete", "cron_toggle", "cron_update",
  "reminder_create", "reminder_delete",
  "discord_send_message", "discord_pin", "discord_unpin",
  "discord_create_thread", "discord_create_forum_post", "discord_delete_thread",
  "discord_edit_message", "discord_delete_message", "discord_archive_thread",
  "google_calendar_list_events", "google_calendar_create_event", "google_calendar_update_event", "google_calendar_delete_event",
  "google_gmail_search", "google_gmail_read", "google_gmail_send", "google_gmail_create_draft",
  "google_drive_search", "google_drive_read", "google_drive_upload",
  "google_tasks_list", "google_tasks_create", "google_tasks_complete", "google_tasks_delete",
  "soul_guardian_approve", "soul_guardian_restore",
  "skill_install", "skill_uninstall",
  "self_evolve",
  "discord_bot_mention_toggle",
  "usage_dashboard",
]);

import { bash } from "./builtin/bash.js";
import { readFileTool } from "./builtin/read-file.js";
import { writeFileTool } from "./builtin/write-file.js";
import { weather } from "./builtin/weather.js";
import { memorySave, memorySearch, memoryList, memoryAdd, memoryReplace, memoryRemove } from "./builtin/memory.js";
import { peopleAdd, peopleUpdate, peopleRemove } from "./builtin/people.js";
import { cronCreate, cronList, cronDelete, cronToggle, cronUpdate } from "./builtin/cron.js";
import { reminderCreate, reminderList, reminderDelete } from "./builtin/reminder.js";
import {
  discordFetchMessage, discordSendMessage, discordReact, discordFetchChannelMessages,
  discordPin, discordUnpin,
  discordCreateThread, discordCreateForumPost, discordDeleteThread,
  discordEditMessage, discordDeleteMessage, discordAttachToReply, discordArchiveThread,
} from "./builtin/discord.js";
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent } from "./builtin/google-calendar.js";
import { gmailSearch, gmailRead, gmailSend, gmailCreateDraft } from "./builtin/google-gmail.js";
import { driveSearch, driveRead, driveUpload } from "./builtin/google-drive.js";
import { tasksList, tasksCreate, tasksComplete, tasksDelete } from "./builtin/google-tasks.js";
import { soulGuardianStatus, soulGuardianCheck, soulGuardianApprove, soulGuardianRestore, soulGuardianHistory } from "./builtin/soul-guardian.js";
import { skillInstall, skillUninstall, skillList } from "./builtin/skill.js";
import { selfEvolve } from "./builtin/self-evolve.js";
import { discordBotMentionToggle } from "./builtin/bot-config.js";
import { sessionSearch } from "./builtin/session-search.js";
import { usageDashboard } from "./builtin/dashboard.js";

const tools: Tool[] = [
  bash, readFileTool, writeFileTool, weather,
  memorySave, memorySearch, memoryList, memoryAdd, memoryReplace, memoryRemove,
  peopleAdd, peopleUpdate, peopleRemove,
  cronCreate, cronList, cronDelete, cronToggle, cronUpdate,
  reminderCreate, reminderList, reminderDelete,
  discordFetchMessage, discordSendMessage, discordReact, discordFetchChannelMessages,
  discordPin, discordUnpin,
  discordCreateThread, discordCreateForumPost, discordDeleteThread,
  discordEditMessage, discordDeleteMessage, discordAttachToReply, discordArchiveThread,
  calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent,
  gmailSearch, gmailRead, gmailSend, gmailCreateDraft,
  driveSearch, driveRead, driveUpload,
  tasksList, tasksCreate, tasksComplete, tasksDelete,
  soulGuardianStatus, soulGuardianCheck, soulGuardianApprove, soulGuardianRestore, soulGuardianHistory,
  skillInstall, skillUninstall, skillList,
  selfEvolve,
  sessionSearch,
  discordBotMentionToggle,
  usageDashboard,
];

const executorMap = new Map(tools.map(t => [t.name, t.execute]));

/** Anthropic tool format (custom tools + server-side web_search) */
export const anthropicTools = [
  ...tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  })),
  { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 },
  { type: "code_execution_20250825", name: "code_execution" },
];

/**
 * bash 是沒有沙箱的任意指令執行——開放給非 owner 等於把 shell 開給任何
 * 能 @ 到 bot 的人。預設鎖成 owner-only，要放寬得自己在 config 明示。
 */
function isOwnerOnly(name: string): boolean {
  if (name === "bash") {
    const { bash_owner_only, bash_allowed_users } = loadConfig().tools;
    if (!bash_owner_only) return false;
    // 例外人員：名單上的 user 也能用 bash（僅 bash，其他 owner-only 工具照擋）
    const userId = getUserId();
    return !(userId && bash_allowed_users.includes(userId));
  }
  return OWNER_ONLY_TOOLS.has(name);
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (isOwnerOnly(name) && getTrigger() === "discord-other") {
    logger.warn({ tool: name, trigger: getTrigger() }, "tool permission denied");
    return "⚠️ PERMISSION DENIED: This tool is owner-only. You are responding to a non-owner user. Do NOT attempt to use this tool again for this request.";
  }
  const executor = executorMap.get(name);
  if (!executor) return `Unknown tool: ${name}`;
  return executor(args);
}
