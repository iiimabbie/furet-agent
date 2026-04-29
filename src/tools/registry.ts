import type { Tool } from "../types.js";
import { logger } from "../logger.js";
export { setTrigger, getTrigger } from "./context.js";
import { getTrigger } from "./context.js";

const OWNER_ONLY_TOOLS = new Set([
  "bash", "write_file",
  "memory_replace", "memory_remove",
  "cron_create", "cron_delete", "cron_toggle", "cron_update",
  "reminder_create", "reminder_delete",
  "discord_send_message", "discord_pin", "discord_unpin",
  "discord_create_thread", "discord_create_forum_post", "discord_delete_thread",
  "discord_edit_message", "discord_delete_message",
  "google_calendar_list_events", "google_calendar_create_event", "google_calendar_update_event", "google_calendar_delete_event",
  "google_gmail_search", "google_gmail_read", "google_gmail_send", "google_gmail_create_draft",
  "google_drive_search", "google_drive_read", "google_drive_upload",
  "google_tasks_list", "google_tasks_create", "google_tasks_complete", "google_tasks_delete",
  "soul_guardian_approve", "soul_guardian_restore",
  "skill_install", "skill_uninstall",
  "self_evolve",
]);

import { bash } from "./builtin/bash.js";
import { readFileTool } from "./builtin/read-file.js";
import { writeFileTool } from "./builtin/write-file.js";
import { weather } from "./builtin/weather.js";
import { memorySave, memorySearch, memoryList, memoryReplace, memoryRemove } from "./builtin/memory.js";
import { cronCreate, cronList, cronDelete, cronToggle, cronUpdate } from "./builtin/cron.js";
import { reminderCreate, reminderList, reminderDelete } from "./builtin/reminder.js";
import {
  discordFetchMessage, discordSendMessage, discordReact, discordFetchChannelMessages,
  discordPin, discordUnpin,
  discordCreateThread, discordCreateForumPost, discordDeleteThread,
  discordEditMessage, discordDeleteMessage, discordAttachToReply,
} from "./builtin/discord.js";
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent } from "./builtin/google-calendar.js";
import { gmailSearch, gmailRead, gmailSend, gmailCreateDraft } from "./builtin/google-gmail.js";
import { driveSearch, driveRead, driveUpload } from "./builtin/google-drive.js";
import { tasksList, tasksCreate, tasksComplete, tasksDelete } from "./builtin/google-tasks.js";
import { soulGuardianStatus, soulGuardianCheck, soulGuardianApprove, soulGuardianRestore, soulGuardianHistory } from "./builtin/soul-guardian.js";
import { skillInstall, skillUninstall, skillList } from "./builtin/skill.js";
import { selfEvolve } from "./builtin/self-evolve.js";

const tools: Tool[] = [
  bash, readFileTool, writeFileTool, weather,
  memorySave, memorySearch, memoryList, memoryReplace, memoryRemove,
  cronCreate, cronList, cronDelete, cronToggle, cronUpdate,
  reminderCreate, reminderList, reminderDelete,
  discordFetchMessage, discordSendMessage, discordReact, discordFetchChannelMessages,
  discordPin, discordUnpin,
  discordCreateThread, discordCreateForumPost, discordDeleteThread,
  discordEditMessage, discordDeleteMessage, discordAttachToReply,
  calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent,
  gmailSearch, gmailRead, gmailSend, gmailCreateDraft,
  driveSearch, driveRead, driveUpload,
  tasksList, tasksCreate, tasksComplete, tasksDelete,
  soulGuardianStatus, soulGuardianCheck, soulGuardianApprove, soulGuardianRestore, soulGuardianHistory,
  skillInstall, skillUninstall, skillList,
  selfEvolve,
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

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (OWNER_ONLY_TOOLS.has(name) && getTrigger() === "discord-other") {
    logger.warn({ tool: name, trigger: getTrigger() }, "tool permission denied");
    return "⚠️ PERMISSION DENIED: This tool is owner-only. You are responding to a non-owner user. Do NOT attempt to use this tool again for this request.";
  }
  const executor = executorMap.get(name);
  if (!executor) return `Unknown tool: ${name}`;
  return executor(args);
}
