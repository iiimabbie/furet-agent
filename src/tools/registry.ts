import type { Tool } from "../types.js";

import { bash } from "./builtin/bash.js";
import { readFileTool } from "./builtin/read-file.js";
import { writeFileTool } from "./builtin/write-file.js";
import { weather } from "./builtin/weather.js";
import { memorySave, memorySearch, memoryList, memoryUpdateIndex } from "./builtin/memory.js";
import { cronCreate, cronList, cronDelete, cronToggle, cronUpdate } from "./builtin/cron.js";
import { reminderCreate, reminderList, reminderDelete } from "./builtin/reminder.js";
import {
  discordFetchMessage, discordSendMessage, discordReact, discordFetchChannelMessages,
  discordPin, discordUnpin,
  discordCreateThread, discordCreateForumPost, discordDeleteThread,
  discordEditMessage, discordDeleteMessage,
} from "./builtin/discord.js";
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent } from "./builtin/google-calendar.js";
import { gmailSearch, gmailRead, gmailSend, gmailCreateDraft } from "./builtin/google-gmail.js";
import { driveSearch, driveRead, driveUpload } from "./builtin/google-drive.js";
import { tasksList, tasksCreate, tasksComplete, tasksDelete } from "./builtin/google-tasks.js";
import { soulGuardianStatus, soulGuardianCheck, soulGuardianApprove, soulGuardianRestore } from "./builtin/soul-guardian.js";

const tools: Tool[] = [
  bash, readFileTool, writeFileTool, weather,
  memorySave, memorySearch, memoryList, memoryUpdateIndex,
  cronCreate, cronList, cronDelete, cronToggle, cronUpdate,
  reminderCreate, reminderList, reminderDelete,
  discordFetchMessage, discordSendMessage, discordReact, discordFetchChannelMessages,
  discordPin, discordUnpin,
  discordCreateThread, discordCreateForumPost, discordDeleteThread,
  discordEditMessage, discordDeleteMessage,
  calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent,
  gmailSearch, gmailRead, gmailSend, gmailCreateDraft,
  driveSearch, driveRead, driveUpload,
  tasksList, tasksCreate, tasksComplete, tasksDelete,
  soulGuardianStatus, soulGuardianCheck, soulGuardianApprove, soulGuardianRestore,
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
  const executor = executorMap.get(name);
  if (!executor) return `Unknown tool: ${name}`;
  return executor(args);
}
