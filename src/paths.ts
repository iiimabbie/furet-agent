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
export const OWNER_FILE = resolve(WORKSPACE_DIR, "OWNER.md");
export const WORKSPACE_CONFIG_DIR = resolve(WORKSPACE_DIR, "config");
export const CRONS_FILE = resolve(WORKSPACE_CONFIG_DIR, "crons.json");
export const REMINDERS_FILE = resolve(WORKSPACE_CONFIG_DIR, "reminders.json");
export const DISCORD_BUTTONS_FILE = resolve(WORKSPACE_CONFIG_DIR, "discord-buttons.json");
export const GOOGLE_TOKEN_PATH = resolve(WORKSPACE_CONFIG_DIR, "google-token.json");
export const SKILLS_DIR = resolve(WORKSPACE_DIR, "skills");

/**
 * agent 產生或抓下來的檔案一律落在這裡：下載的圖片、Discord 附件、
 * 產出的報表／HTML、暫存檔。不要再另開 `pages/`、`tmp/` 之類的同級目錄。
 */
export const ATTACHMENTS_DIR = resolve(WORKSPACE_DIR, "attachments");

/**
 * 全域唯一的回收桶。刪除一律 `mv` 到這裡，不用 `rm`。
 *
 * 刻意放在 workspace 頂層而非 attachments 底下，並且指定到絕對位置：
 * 只說「移到 .trash」的話，agent 會依當下工作目錄各建一個，散成多個回收桶。
 */
export const TRASH_DIR = resolve(WORKSPACE_DIR, ".trash");
