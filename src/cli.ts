import * as readline from "node:readline";
import { ask } from "./agent.js";
import { fixMarkdownLinks } from "./utils/format.js";

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

    try {
      const response = await ask(trimmed, {
        onToolUse: (tool, toolInput) => {
          const displayName = prettifyToolName(tool);
          const summary = formatToolSummary(tool, toolInput);
          console.log(`  🔧 ${displayName}${summary}`);
        },
      });

      console.log(`\n${fixMarkdownLinks(response.text)}`);
      console.log(`\n--- ${(response.durationMs / 1000).toFixed(1)}s | tools: ${response.toolsUsed.map(t => prettifyToolName(t.tool)).join(", ") || "none"} ---`);
    } catch (err) {
      console.error("\n🤕 Error:", (err as Error).message);
    }

    prompt();
  });
}

function prettifyToolName(raw: string): string {
  const first = raw.charAt(0).toUpperCase() + raw.slice(1);
  return first;
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

console.log("Furet CLI — type 'exit' to quit");
prompt();
