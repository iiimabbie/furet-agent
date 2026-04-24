import * as readline from "node:readline";
import { ask } from "./agent.js";
import { Session } from "./session.js";
import { fixMarkdownLinks } from "./utils/format.js";

let session = new Session("cli");

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
      session.clear();
      console.log("new session started");
      prompt();
      return;
    }

    try {
      const response = await ask(trimmed, {
        session,
        trigger: "cli",
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
  memory_save: "MemorySave",
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

console.log(`Furet CLI — type 'new' for new session, 'exit' to quit (history: ${session.length} messages)`);
prompt();
