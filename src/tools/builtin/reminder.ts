import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";

const REMINDERS_FILE = resolve(import.meta.dirname ?? process.cwd(), "../../..", "workspace", "reminders.json");

export interface Reminder {
  id: string;
  name: string;
  triggerAt: string;   // ISO datetime
  prompt: string;
  createdAt: string;
}

export function loadReminders(): Reminder[] {
  try {
    return JSON.parse(readFileSync(REMINDERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveReminders(list: Reminder[]): void {
  mkdirSync(resolve(REMINDERS_FILE, ".."), { recursive: true });
  writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2));
}

// --- Tool Definitions ---

export const reminderCreateDefinition = {
  type: "function" as const,
  function: {
    name: "reminder_create",
    description: "Create a one-time reminder that triggers once at a specific time. Use this for 'remind me at X' or 'in N minutes' type requests. For recurring tasks, use cron_create instead.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name for this reminder" },
        trigger_at: { type: "string", description: "ISO 8601 datetime when to trigger (e.g. '2026-04-15T14:30:00+08:00'). Calculate from current date if user says relative time like 'in 5 minutes'." },
        prompt: { type: "string", description: "The prompt to execute when triggered" },
      },
      required: ["name", "trigger_at", "prompt"],
    },
  },
};

export const reminderListDefinition = {
  type: "function" as const,
  function: {
    name: "reminder_list",
    description: "List all pending one-time reminders.",
    parameters: { type: "object", properties: {} },
  },
};

export const reminderDeleteDefinition = {
  type: "function" as const,
  function: {
    name: "reminder_delete",
    description: "Delete a pending reminder by ID.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Reminder ID" },
      },
      required: ["id"],
    },
  },
};

// --- Executors ---

export async function executeReminderCreate(args: { name: string; trigger_at: string; prompt: string }): Promise<string> {
  const triggerDate = new Date(args.trigger_at);
  if (isNaN(triggerDate.getTime())) {
    return `Error: invalid datetime "${args.trigger_at}"`;
  }
  if (triggerDate.getTime() <= Date.now()) {
    return `Error: trigger_at must be in the future (got ${args.trigger_at}, now is ${new Date().toISOString()})`;
  }

  const list = loadReminders();
  const reminder: Reminder = {
    id: randomUUID().slice(0, 8),
    name: args.name,
    triggerAt: triggerDate.toISOString(),
    prompt: args.prompt,
    createdAt: new Date().toISOString(),
  };
  list.push(reminder);
  saveReminders(list);
  logger.info({ id: reminder.id, name: reminder.name, triggerAt: reminder.triggerAt }, "reminder created");
  return `Created reminder "${reminder.name}" (${reminder.id}), triggers at: ${reminder.triggerAt}`;
}

export async function executeReminderList(): Promise<string> {
  const list = loadReminders();
  if (list.length === 0) return "No pending reminders.";
  return list.map(r =>
    `${r.id} | ${r.name} | ${r.triggerAt} | "${r.prompt.slice(0, 50)}"`
  ).join("\n");
}

export async function executeReminderDelete(args: { id: string }): Promise<string> {
  const list = loadReminders();
  const idx = list.findIndex(r => r.id === args.id);
  if (idx === -1) return `Reminder "${args.id}" not found.`;
  const removed = list.splice(idx, 1)[0];
  saveReminders(list);
  logger.info({ id: removed.id }, "reminder deleted");
  return `Deleted reminder "${removed.name}"`;
}
