import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");

export const WORKSPACE_DIR = resolve(ROOT, "workspace");
export const LOGS_DIR = resolve(ROOT, "logs");
export const CONFIG_PATH = resolve(ROOT, "config.yaml");
export const SESSIONS_DIR = resolve(WORKSPACE_DIR, "sessions");
export const ARCHIVE_DIR = resolve(SESSIONS_DIR, "archive");
export const MEMORY_DIR = resolve(WORKSPACE_DIR, "memory");
export const MEMORY_INDEX = resolve(WORKSPACE_DIR, "MEMORY.md");
export const CRONS_FILE = resolve(WORKSPACE_DIR, "crons.json");
export const REMINDERS_FILE = resolve(WORKSPACE_DIR, "reminders.json");
export const SKILLS_DIR = resolve(WORKSPACE_DIR, "skills");
