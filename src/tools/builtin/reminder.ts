import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import { REMINDERS_FILE } from "../../paths.js";
import type { Tool } from "../../types.js";

export interface Reminder {
  id: string;
  name: string;
  triggerAt: string;
  prompt: string;
  createdAt: string;
  channel_id?: string;
}

export function loadReminders(): Reminder[] {
  try {
    return JSON.parse(readFileSync(REMINDERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveReminders(list: Reminder[]): void {
  mkdirSync(dirname(REMINDERS_FILE), { recursive: true });
  writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2));
}

export const reminderCreate: Tool = {
  name: "reminder_create",
  description: "Create a one-time reminder that triggers once at a specific time. Use this for 'remind me at X' or 'in N minutes' type requests. For recurring tasks, use cron_create instead.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short name for this reminder" },
      trigger_at: { type: "string", description: "ISO 8601 datetime when to trigger (e.g. '2026-04-15T14:30:00+08:00'). Calculate from current date if user says relative time like 'in 5 minutes'." },
      prompt: { type: "string", description: "Instruction for your future self when it fires, NOT the message the user sees (you write that then). Include the facts needed — absolute dates, amounts, names — and no relative time like 'in 3 days'." },
      channel_id: { type: "string", description: "Discord channel ID to send the result to. If omitted, result is only logged." },
    },
    required: ["name", "trigger_at", "prompt"],
  },
  execute: async (args) => {
    const { name, trigger_at, prompt, channel_id } = args as { name: string; trigger_at: string; prompt: string; channel_id?: string };
    const triggerDate = new Date(trigger_at);
    if (isNaN(triggerDate.getTime())) return `Error: invalid datetime "${trigger_at}"`;
    if (triggerDate.getTime() <= Date.now()) {
      return `Error: trigger_at must be in the future (got ${trigger_at}, now is ${new Date().toISOString()})`;
    }

    const list = loadReminders();
    const reminder: Reminder = {
      id: randomUUID().slice(0, 8),
      name,
      triggerAt: triggerDate.toISOString(),
      prompt,
      createdAt: new Date().toISOString(),
      ...(channel_id ? { channel_id } : {}),
    };
    list.push(reminder);
    saveReminders(list);
    logger.info({ id: reminder.id, name: reminder.name, triggerAt: reminder.triggerAt }, "reminder created");
    return `Created reminder "${reminder.name}" (${reminder.id}), triggers at: ${reminder.triggerAt}`;
  },
};

export const reminderList: Tool = {
  name: "reminder_list",
  description: "List all pending one-time reminders.",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    const list = loadReminders();
    if (list.length === 0) return "No pending reminders.";
    return list.map(r =>
      `${r.id} | ${r.name} | ${r.triggerAt} | "${r.prompt.slice(0, 50)}"`
    ).join("\n");
  },
};

export const reminderDelete: Tool = {
  name: "reminder_delete",
  description: "Delete a pending reminder by ID.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Reminder ID" },
    },
    required: ["id"],
  },
  execute: async (args) => {
    const { id } = args as { id: string };
    const list = loadReminders();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return `Reminder "${id}" not found.`;
    const removed = list.splice(idx, 1)[0];
    saveReminders(list);
    logger.info({ id: removed.id }, "reminder deleted");
    return `Deleted reminder "${removed.name}"`;
  },
};
