import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { bashDefinition, executeBash } from "./tools/builtin/bash.js";
import { readFileDefinition, executeReadFile } from "./tools/builtin/read-file.js";
import { writeFileDefinition, executeWriteFile } from "./tools/builtin/write-file.js";
import { webSearchDefinition, executeWebSearch } from "./tools/builtin/web-search.js";
import "dotenv/config";

const client = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL,
});

const MODEL = process.env.LLM_MODEL ?? "claude-sonnet-4-20250514";

export interface ToolActivity {
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentResponse {
  text: string;
  toolsUsed: ToolActivity[];
  durationMs: number;
}

export interface AgentOptions {
  systemPrompt?: string;
  maxTurns?: number;
  onToolUse?: (tool: string, input: Record<string, unknown>) => void;
}

// System-level instructions — hardcoded, not user-configurable.
const SYSTEM_INSTRUCTIONS = `
You are Furet, a personal assistant agent.

## Execution Rules
1. Always fulfill the user's request FIRST. Deliver the answer/result before any side-effects.
2. When a tool returns data, ALWAYS include the relevant information in your response.
3. Respond in the same language the user uses.

## Using your tools
- Use the RIGHT tool for each job. Do NOT use bash when a dedicated tool exists:
  - To read files: use read_file, NOT cat/head/tail
  - To write files: use write_file, NOT echo/cat with redirection
  - To search file content: use grep, NOT bash grep
- Reserve bash exclusively for shell commands that have no dedicated tool (git, curl, npm, etc.)

## Tone and style
- Be short and concise.
- Only use emojis if the user uses them first.
`;

function loadPersona(): string {
  try {
    const personaPath = resolve(import.meta.dirname ?? process.cwd(), "..", "workspace", "FURET.md");
    return readFileSync(personaPath, "utf-8");
  } catch {
    return "";
  }
}

function buildSystemPrompt(extra?: string): string {
  return [SYSTEM_INSTRUCTIONS, loadPersona(), extra].filter(Boolean).join("\n");
}

const TOOLS: OpenAI.ChatCompletionTool[] = [
  bashDefinition,
  readFileDefinition,
  writeFileDefinition,
  webSearchDefinition,
];

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "bash": return executeBash(args as { command: string });
    case "read_file": return executeReadFile(args as { path: string });
    case "write_file": return executeWriteFile(args as { path: string; content: string });
    case "web_search": return executeWebSearch(args as { query: string });
    default: return `Unknown tool: ${name}`;
  }
}

export async function ask(prompt: string, options: AgentOptions = {}): Promise<AgentResponse> {
  const startTime = Date.now();
  const maxTurns = options.maxTurns ?? 10;
  const toolsUsed: ToolActivity[] = [];

  logger.info({ prompt: prompt.slice(0, 200) }, "query start");

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(options.systemPrompt) },
    { role: "user", content: prompt },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS.length > 0 ? TOOLS : undefined,
    });

    const choice = response.choices[0];
    const message = choice.message;

    // 把 assistant 回覆加進 messages（給下一輪用）
    messages.push(message);

    // 沒有 tool call → 回文字，結束
    if (!message.tool_calls || message.tool_calls.length === 0) {
      const durationMs = Date.now() - startTime;
      logger.info({ durationMs, toolsUsed: toolsUsed.map(t => t.tool) }, "query done");
      return {
        text: message.content ?? "",
        toolsUsed,
        durationMs,
      };
    }

    // 有 tool call → 執行每個 tool，結果加回 messages
    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") continue;
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

      toolsUsed.push({ tool: toolName, input: toolArgs });
      logger.info({ tool: toolName, input: toolArgs }, "tool call");
      options.onToolUse?.(toolName, toolArgs);

      const result = await executeTool(toolName, toolArgs);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  // max turns 用完
  const durationMs = Date.now() - startTime;
  logger.error({ maxTurns }, "max turns reached");
  return {
    text: "達到最大回合數限制。",
    toolsUsed,
    durationMs,
  };
}
