import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");

export const WORKSPACE_DIR = resolve(ROOT, "workspace");
export const LOGS_DIR = resolve(ROOT, "logs");
export const CONFIG_PATH = resolve(ROOT, "config.yaml");
export const SESSIONS_DIR = resolve(WORKSPACE_DIR, "sessions");
export const ARCHIVE_DIR = resolve(SESSIONS_DIR, "archive");
export const MEMORY_DIR = resolve(WORKSPACE_DIR, "memory");
export const MEMORY_INDEX = resolve(WORKSPACE_DIR, "MEMORY.md");
export const PEOPLE_FILE = resolve(WORKSPACE_DIR, "PEOPLE.md");
export const WORKSPACE_CONFIG_DIR = resolve(WORKSPACE_DIR, "config");
export const CRONS_FILE = resolve(WORKSPACE_CONFIG_DIR, "crons.json");
export const REMINDERS_FILE = resolve(WORKSPACE_CONFIG_DIR, "reminders.json");
export const GOOGLE_TOKEN_PATH = resolve(WORKSPACE_CONFIG_DIR, "google-token.json");
export const SKILLS_DIR = resolve(WORKSPACE_DIR, "skills");
