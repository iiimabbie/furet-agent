import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { weatherServer } from "./tools/weather.js";
import { logger } from "./logger.js";

// 把使用者友善的環境變數映射給 SDK
if (process.env.LLM_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.LLM_API_KEY;
}
if (process.env.LLM_BASE_URL && !process.env.ANTHROPIC_BASE_URL) {
  process.env.ANTHROPIC_BASE_URL = process.env.LLM_BASE_URL;
}

export interface ToolActivity {
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentResponse {
  text: string;
  cost: number;
  durationMs: number;
  sessionId?: string;
  toolsUsed: ToolActivity[];
}

export interface AgentOptions {
  systemPrompt?: string;
  maxTurns?: number;
  cwd?: string;
  resume?: string;        // session ID to continue
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  onToolUse?: (tool: string, input: Record<string, unknown>) => void;
}

// System-level instructions: execution flow, priorities, tool usage rules.
// Hardcoded — not user-configurable.
const SYSTEM_INSTRUCTIONS = `
## Execution Rules
1. Always fulfill the user's request FIRST. Deliver the answer/result before any side-effects.
2. Side-effects (saving memories, taking notes, organizing files) happen AFTER the response, or concurrently without delaying the response.
3. Do NOT mention side-effects in your reply unless the user explicitly asks.
4. When a tool returns data, ALWAYS include the relevant information in your response. Never say "I looked it up" without sharing what you found.
5. Respond in the same language the user uses.
6. Do NOT use the built-in memory system. Do NOT write to ~/.claude/projects/ or any memory files. Memory will be handled by dedicated tools in the future.
`;

function loadPersona(): string {
  try {
    const personaPath = resolve(import.meta.dirname ?? process.cwd(), "..", "workspace", "FURET.md");
    return readFileSync(personaPath, "utf-8");
  } catch {
    return "";
  }
}

const DEFAULT_ALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit",
  "Glob", "Grep",
  "WebSearch", "WebFetch",
  "Task",
  "mcp__weather__query",
];

export async function ask(prompt: string, options: AgentOptions = {}): Promise<AgentResponse> {
  logger.info({ prompt: prompt.slice(0, 200) }, "query start");

  let resultText = "";
  let totalCost = 0;
  let duration = 0;
  let sessionId: string | undefined;
  const toolsUsed: ToolActivity[] = [];

  for await (const message of query({
    prompt,
    options: {
      maxTurns: options.maxTurns ?? 10,
      cwd: options.cwd ?? process.cwd(),
      allowedTools: options.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: SYSTEM_INSTRUCTIONS + loadPersona() + (options.systemPrompt ?? ""),
      },
      permissionMode: "acceptEdits",
      mcpServers: {
        weather: weatherServer,
        ...(options.mcpServers as Record<string, never> | undefined),
      },
      resume: options.resume,
    },
  })) {
    const msg = message as Record<string, unknown>;

    // tool 使用資訊在 assistant message 的 content blocks 裡
    if (msg.type === "assistant") {
      const assistantMsg = msg.message as Record<string, unknown> | undefined;
      const content = assistantMsg?.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === "tool_use") {
            const toolName = (block.name as string) ?? "unknown";
            const toolInput = (block.input as Record<string, unknown>) ?? {};
            toolsUsed.push({ tool: toolName, input: toolInput });
            logger.info({ tool: toolName, input: toolInput }, "tool call");
            options.onToolUse?.(toolName, toolInput);
          }
        }
      }
    }

    if (msg.type === "result" && msg.subtype === "success") {
      resultText = (msg.result as string) ?? "";
      totalCost = (msg.total_cost_usd as number) ?? 0;
      duration = (msg.duration_ms as number) ?? 0;
      sessionId = msg.session_id as string | undefined;
    }

    if (msg.type === "result" && msg.subtype !== "success") {
      logger.error({ subtype: msg.subtype, result: (msg.result as string)?.slice(0, 500) }, "query failed");
    }
  }

  logger.info({ cost: totalCost, durationMs: duration, toolsUsed: toolsUsed.map(t => t.tool), sessionId }, "query done");

  return {
    text: resultText,
    cost: totalCost,
    durationMs: duration,
    sessionId,
    toolsUsed,
  };
}
