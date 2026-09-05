import * as readline from "node:readline";
import { ask } from "./agent.js";
import { Session } from "./session.js";
import { fixMarkdownLinks } from "./utils/format.js";
import { startSearchIndexWorker, stopSearchIndexWorker } from "./search-index.js";
import { startAttachmentIndexWorker, stopAttachmentIndexWorker } from "./attachment-index.js";

/**
 * CLI 只能在主機的 shell 上執行，打字的人必然是 owner——`trigger: "cli"` 也因此享有完整權限。
 * 身分由這裡告知，不讓 agent 從「沒有身分資訊」去猜：猜的結果是它退回中性稱呼。
 */
const CLI_CONTEXT = `<cli-context>
This is a local CLI session on the host machine. The person typing is the owner.
Address them as <owner> specifies.
</cli-context>`;

let session = new Session("cli");

startSearchIndexWorker();
startAttachmentIndexWorker();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(): void {
  rl.question("\n🐾 > ", async (input) => {
    const trimmed = input.trim();

    if (!trimmed || trimmed === "exit" || trimmed === "quit") {
      console.log("bye!");
      rl.close();
      return;
    }

    if (trimmed === "new") {
      // archive() returns the archive path on success, or null when the session was
      // empty OR its durable archive could not be written. On write failure it
      // deliberately RETAINS the active session (does not clear), so opening a fresh
      // session here would abandon still-live history without telling the operator.
      // Distinguish the two null cases so a real failure is surfaced and the current
      // session is kept instead of silently replaced.
      const hadHistory = session.length > 0;
      const archivePath = session.archive();
      if (archivePath === null && hadHistory && session.length > 0) {
        console.error("⚠️  previous session was NOT archived (durable write failed); keeping it active. Fix the archive path and retry 'new'.");
        prompt();
        return;
      }
      session = new Session("cli");
      console.log(archivePath
        ? "new session started (previous session archived)"
        : "new session started (previous session was empty)");
      prompt();
      return;
    }

    try {
      const response = await ask(trimmed, {
        session,
        systemPrompt: CLI_CONTEXT,
        trigger: "cli",
        peopleVisibility: "owner",
        onToolUse: (tool, toolInput) => {
          const displayName = prettifyToolName(tool);
          const summary = formatToolSummary(tool, toolInput);
          console.log(`  🔧 ${displayName}${summary}`);
        },
      });

      console.log(`\n${fixMarkdownLinks(response.text)}`);
      const uniqueTools = [...new Set(response.toolsUsed.map(t => prettifyToolName(t.tool)))];
      console.log(`\n--- ${(response.durationMs / 1000).toFixed(1)}s | tools: ${uniqueTools.join(", ") || "none"} ---`);
    } catch (err) {
      console.error("\n🤕 Error:", (err as Error).message);
    }

    prompt();
  });
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  bash: "Bash",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  grep: "Grep",
  glob: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  get_weather: "Weather",
  memory_search: "MemorySearch",
  memory_list: "MemoryList",
  memory_update_index: "MemoryIndex",
  cron_create: "CronCreate",
  cron_list: "CronList",
  cron_delete: "CronDelete",
  cron_toggle: "CronToggle",
  reminder_create: "ReminderCreate",
  reminder_list: "ReminderList",
  reminder_delete: "ReminderDelete",
};

function prettifyToolName(raw: string): string {
  return TOOL_DISPLAY_NAMES[raw] ?? raw;
}

function formatToolSummary(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "bash":
      return ` → ${truncate(String(input.command ?? ""), 60)}`;
    case "read_file":
      return ` → ${input.path}`;
    case "write_file":
      return ` → ${input.path}`;
    case "edit_file":
      return ` → ${input.path}`;
    case "grep":
      return ` → "${input.pattern}"`;
    case "glob":
      return ` → ${input.pattern}`;
    case "web_search":
      return ` → "${input.query}"`;
    case "web_fetch":
      return ` → ${input.url}`;
    case "get_weather":
      return ` → ${input.city}`;
    default:
      return "";
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopSearchIndexWorker();
  stopAttachmentIndexWorker();
}
rl.once("close", shutdown);
process.once("SIGINT", () => { shutdown(); rl.close(); });
process.once("SIGTERM", () => { shutdown(); rl.close(); });

console.log(`Umiro CLI — type 'new' for new session, 'exit' to quit (history: ${session.length} messages)`);
prompt();
