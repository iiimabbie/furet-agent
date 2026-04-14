import * as readline from "node:readline";
import { ask } from "./agent.js";
import { fixMarkdownLinks } from "./utils/format.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let sessionId: string | undefined;

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
        resume: sessionId,
        onToolUse: (tool, toolInput) => {
          const displayName = prettifyToolName(tool);
          const summary = formatToolSummary(tool, toolInput);
          console.log(`  🔧 ${displayName}${summary}`);
        },
      });

      sessionId = response.sessionId;

      console.log(`\n${fixMarkdownLinks(response.text)}`);
      console.log(`\n--- cost: $${response.cost.toFixed(4)} | ${(response.durationMs / 1000).toFixed(1)}s | tools: ${response.toolsUsed.map(t => prettifyToolName(t.tool)).join(", ") || "none"} ---`);
    } catch (err) {
      console.error("\n🤕 Error:", (err as Error).message);
    }

    prompt();
  });
}

/**
 * mcp__weather__query → GetWeather
 * mcp__discord__send  → DiscordSend
 * Bash                → Bash
 */
function prettifyToolName(raw: string): string {
  if (!raw.startsWith("mcp__")) return raw;
  const parts = raw.replace("mcp__", "").split("__");
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

function formatToolSummary(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Bash":
      return ` → ${truncate(String(input.command ?? ""), 60)}`;
    case "Read":
      return ` → ${input.file_path}`;
    case "Write":
    case "Edit":
      return ` → ${input.file_path}`;
    case "Grep":
      return ` → "${input.pattern}"`;
    case "Glob":
      return ` → ${input.pattern}`;
    case "WebSearch":
      return ` → "${input.query}"`;
    case "WebFetch":
      return ` → ${input.url}`;
    case "Task":
      return ` → ${truncate(String(input.prompt ?? ""), 40)}`;
    default:
      return "";
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

console.log("Furet CLI — type 'exit' to quit");
prompt();
