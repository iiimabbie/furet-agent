import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { validate } from "node-cron";
import { logger } from "../../logger.js";
import { CRONS_FILE } from "../../paths.js";
import type { Tool } from "../../types.js";

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  channel_id?: string;
  /** "always": send any response to Discord (default). "on_event": agent replies with empty text to stay silent, text only when something is worth reporting. */
  notify?: "always" | "on_event";
}

export function loadCrons(): CronJob[] {
  try {
    return JSON.parse(readFileSync(CRONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveCrons(crons: CronJob[]): void {
  mkdirSync(dirname(CRONS_FILE), { recursive: true });
  writeFileSync(CRONS_FILE, JSON.stringify(crons, null, 2));
}

export const cronCreate: Tool = {
  name: "cron_create",
  description: "Create a scheduled task. The prompt will be executed by the agent on the given cron schedule.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short name for this task" },
      schedule: { type: "string", description: "Cron expression (e.g. '0 9 * * *' for daily 9am, '*/30 * * * *' for every 30 min)" },
      prompt: { type: "string", description: "The prompt to execute when triggered" },
      channel_id: { type: "string", description: "Discord channel ID to send the result to." },
      notify: { type: "string", enum: ["always", "on_event"], description: "'always' (default): every response is sent to Discord. 'on_event': agent replies with empty text to stay silent, only sends text when something is worth reporting (errors, anomalies, important updates)." },
    },
    required: ["name", "schedule", "prompt", "channel_id"],
  },
  execute: async (args) => {
    const { name, schedule, prompt, channel_id, notify } = args as { name: string; schedule: string; prompt: string; channel_id: string; notify?: "always" | "on_event" };
    if (!validate(schedule)) return `Invalid cron expression: "${schedule}"`;
    const crons = loadCrons();
    const job: CronJob = {
      id: randomUUID().slice(0, 8),
      name,
      schedule,
      prompt,
      enabled: true,
      createdAt: new Date().toISOString(),
      ...(channel_id ? { channel_id } : {}),
      ...(notify ? { notify } : {}),
    };
    crons.push(job);
    saveCrons(crons);
    logger.info({ id: job.id, name: job.name, schedule: job.schedule }, "cron created");
    return `Created cron "${job.name}" (${job.id}), schedule: ${job.schedule}`;
  },
};

export const cronList: Tool = {
  name: "cron_list",
  description: "List all scheduled tasks.",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    const crons = loadCrons();
    if (crons.length === 0) return "No scheduled tasks.";
    return crons.map(c =>
      `[${c.enabled ? "ON" : "OFF"}] ${c.id} | ${c.name} | ${c.schedule} | "${c.prompt.slice(0, 50)}"`
    ).join("\n");
  },
};

export const cronDelete: Tool = {
  name: "cron_delete",
  description: "Delete a scheduled task by ID.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The cron job ID to delete" },
    },
    required: ["id"],
  },
  execute: async (args) => {
    const { id } = args as { id: string };
    const crons = loadCrons();
    const idx = crons.findIndex(c => c.id === id);
    if (idx === -1) return `Cron job "${id}" not found.`;
    const removed = crons.splice(idx, 1)[0];
    saveCrons(crons);
    logger.info({ id: removed.id, name: removed.name }, "cron deleted");
    return `Deleted cron "${removed.name}" (${removed.id})`;
  },
};

export const cronToggle: Tool = {
  name: "cron_toggle",
  description: "Enable or disable a scheduled task.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The cron job ID" },
      enabled: { type: "boolean", description: "true to enable, false to disable" },
    },
    required: ["id", "enabled"],
  },
  execute: async (args) => {
    const { id, enabled } = args as { id: string; enabled: boolean };
    const crons = loadCrons();
    const job = crons.find(c => c.id === id);
    if (!job) return `Cron job "${id}" not found.`;
    job.enabled = enabled;
    saveCrons(crons);
    logger.info({ id: job.id, enabled: job.enabled }, "cron toggled");
    return `Cron "${job.name}" is now ${job.enabled ? "enabled" : "disabled"}`;
  },
};

export const cronUpdate: Tool = {
  name: "cron_update",
  description: "Update an existing scheduled task. Only the provided fields will be changed; omitted fields remain unchanged.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The cron job ID to update" },
      name: { type: "string", description: "New short name for this task" },
      schedule: { type: "string", description: "New cron expression" },
      prompt: { type: "string", description: "New prompt to execute when triggered" },
      channel_id: { type: "string", description: "New Discord channel ID to send results to." },
      notify: { type: "string", enum: ["always", "on_event"], description: "Change notify mode." },
    },
    required: ["id"],
  },
  execute: async (args) => {
    const { id, name, schedule, prompt, channel_id, notify } = args as {
      id: string;
      name?: string;
      schedule?: string;
      prompt?: string;
      channel_id?: string;
      notify?: "always" | "on_event";
    };
    if (schedule !== undefined && !validate(schedule)) return `Invalid cron expression: "${schedule}"`;
    const crons = loadCrons();
    const job = crons.find(c => c.id === id);
    if (!job) return `Cron job "${id}" not found.`;

    if (name !== undefined) job.name = name;
    if (schedule !== undefined) job.schedule = schedule;
    if (prompt !== undefined) job.prompt = prompt;
    if (channel_id !== undefined) job.channel_id = channel_id;
    if (notify !== undefined) job.notify = notify;

    saveCrons(crons);
    logger.info({ id: job.id, name: job.name }, "cron updated");
    return `Updated cron "${job.name}" (${job.id})`;
  },
};
