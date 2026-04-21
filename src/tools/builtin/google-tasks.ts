import { google } from "googleapis";
import { getAuthClient } from "../../google/auth.js";
import type { Tool } from "../../types.js";

function getTasks() {
  const auth = getAuthClient();
  if (!auth) throw new Error("Google API 未授權，請先用 /google-auth 授權");
  return google.tasks({ version: "v1", auth });
}

export const tasksList: Tool = {
  name: "google_tasks_list",
  description: "List tasks from a task list. Shows incomplete tasks by default.",
  parameters: {
    type: "object",
    properties: {
      task_list_id: { type: "string", description: "Task list ID (default: @default)" },
      show_completed: { type: "boolean", description: "Include completed tasks (default: false)" },
      max_results: { type: "number", description: "Max tasks to return (default: 20)" },
    },
  },
  execute: async (args) => {
    const { task_list_id, show_completed, max_results } = args as {
      task_list_id?: string; show_completed?: boolean; max_results?: number;
    };
    const tasks = getTasks();
    const res = await tasks.tasks.list({
      tasklist: task_list_id || "@default",
      maxResults: max_results || 20,
      showCompleted: show_completed || false,
      showHidden: show_completed || false,
    });
    const items = res.data.items || [];
    if (items.length === 0) return "No tasks.";
    return items.map(t => {
      const status = t.status === "completed" ? "[x]" : "[ ]";
      const due = t.due ? ` (due: ${t.due.split("T")[0]})` : "";
      return `${status} [${t.id}] ${t.title}${due}`;
    }).join("\n");
  },
};

export const tasksCreate: Tool = {
  name: "google_tasks_create",
  description: "Create a new task.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Task title" },
      notes: { type: "string", description: "Task notes/details" },
      due: { type: "string", description: "Due date in ISO 8601 format (e.g. 2026-04-25T00:00:00Z)" },
      task_list_id: { type: "string", description: "Task list ID (default: @default)" },
    },
    required: ["title"],
  },
  execute: async (args) => {
    const { title, notes, due, task_list_id } = args as {
      title: string; notes?: string; due?: string; task_list_id?: string;
    };
    const tasks = getTasks();
    const res = await tasks.tasks.insert({
      tasklist: task_list_id || "@default",
      requestBody: {
        title,
        ...(notes ? { notes } : {}),
        ...(due ? { due } : {}),
      },
    });
    return `Task created: "${res.data.title}" (${res.data.id})`;
  },
};

export const tasksComplete: Tool = {
  name: "google_tasks_complete",
  description: "Mark a task as completed.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task ID" },
      task_list_id: { type: "string", description: "Task list ID (default: @default)" },
    },
    required: ["task_id"],
  },
  execute: async (args) => {
    const { task_id, task_list_id } = args as { task_id: string; task_list_id?: string };
    const tasks = getTasks();
    const res = await tasks.tasks.patch({
      tasklist: task_list_id || "@default",
      task: task_id,
      requestBody: { status: "completed" },
    });
    return `Task completed: "${res.data.title}"`;
  },
};

export const tasksDelete: Tool = {
  name: "google_tasks_delete",
  description: "Delete a task.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task ID" },
      task_list_id: { type: "string", description: "Task list ID (default: @default)" },
    },
    required: ["task_id"],
  },
  execute: async (args) => {
    const { task_id, task_list_id } = args as { task_id: string; task_list_id?: string };
    const tasks = getTasks();
    await tasks.tasks.delete({
      tasklist: task_list_id || "@default",
      task: task_id,
    });
    return `Task deleted (${task_id})`;
  },
};
