import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { activeLlmProfile } from "../src/llm/profile.js";
import { ARCHIVE_DIR, ATTACHMENTS_DIR, SESSIONS_DIR } from "../src/paths.js";

const apply = process.argv.includes("--apply");
const profile = activeLlmProfile(loadConfig());
const modelSettings = {
  profile: profile.name,
  model: profile.model,
  reasoningEffort: profile.reasoningEffort,
  revision: 0,
};
function jsonFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => resolve(directory, entry.name));
}

const files = [...jsonFiles(SESSIONS_DIR), ...jsonFiles(ARCHIVE_DIR)];
const pending: Array<{ path: string; data: Record<string, unknown> }> = [];
for (const path of files) {
  const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (data.modelSettings !== undefined) continue;
  pending.push({ path, data: { modelSettings, ...data } });
}

console.log(JSON.stringify({ apply, profile: profile.name, model: profile.model, scanned: files.length, pending: pending.length }, null, 2));
if (!apply || pending.length === 0) process.exit(0);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = resolve(ATTACHMENTS_DIR, "deployment-backups", `session-model-migration-${stamp}`);
mkdirSync(backupDir, { recursive: true });
for (const item of pending) {
  const relativeGroup = item.path.startsWith(ARCHIVE_DIR) ? "archive" : "active";
  const backupPath = resolve(backupDir, relativeGroup, basename(item.path));
  mkdirSync(resolve(backupDir, relativeGroup), { recursive: true });
  writeFileSync(backupPath, readFileSync(item.path));
  const temp = `${item.path}.${process.pid}.model-migration.tmp`;
  writeFileSync(temp, `${JSON.stringify(item.data, null, 2)}\n`, { flag: "wx" });
  renameSync(temp, item.path);
}
console.log(`Migrated ${pending.length} session files; backup: ${backupDir}`);
