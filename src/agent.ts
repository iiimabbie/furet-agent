import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { loadConfig } from "./config.js";
import { bashDefinition, executeBash } from "./tools/builtin/bash.js";
import { readFileDefinition, executeReadFile } from "./tools/builtin/read-file.js";
import { writeFileDefinition, executeWriteFile } from "./tools/builtin/write-file.js";
import { weatherDefinition, executeWeather } from "./tools/builtin/weather.js";
import {
  memorySaveDefinition, executeMemorySave,
  memorySearchDefinition, executeMemorySearch,
  memoryListDefinition, executeMemoryList,
  memoryUpdateIndexDefinition, executeMemoryUpdateIndex,
} from "./tools/builtin/memory.js";
import {
  cronCreateDefinition, executeCronCreate,
  cronListDefinition, executeCronList,
  cronDeleteDefinition, executeCronDelete,
  cronToggleDefinition, executeCronToggle,
} from "./tools/builtin/cron.js";
import {
  reminderCreateDefinition, executeReminderCreate,
  reminderListDefinition, executeReminderList,
  reminderDeleteDefinition, executeReminderDelete,
} from "./tools/builtin/reminder.js";
import {
  discordFetchMessageDefinition, executeDiscordFetchMessage,
} from "./tools/builtin/discord.js";

const config = loadConfig();
const API_URL = `${config.llm.base_url || "https://api.anthropic.com/v1"}/messages`;
const API_KEY = config.llm.api_key;
const MODEL = config.llm.model;

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
  session?: import("./session.js").Session;
  onToolUse?: (tool: string, input: Record<string, unknown>) => void;
}

// --- Anthropic types ---
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "web_search_tool_result"; content: Array<{ type: string; url?: string; title?: string; encrypted_content?: string }> };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

// --- System prompt ---
const SYSTEM_INSTRUCTIONS = `
You are a personal assistant agent.

## Execution Rules
1. ALWAYS produce a text response. After all tool calls are done, you MUST output text to reply to the user. Never end with only tool calls and no text.
2. Always fulfill the user's request FIRST. Deliver the answer/result before any side-effects.
3. When a tool returns data, ALWAYS include the relevant information in your response.
4. After answering a web search question, include a "Sources:" section with relevant [title](url) links from the search results.
5. Respond in the same language the user uses.

## Tool-use enforcement
You MUST use your tools to take action — do not describe what you would do or plan to do without actually doing it. When you say you will perform an action (e.g. "I will run the tests", "Let me check the file", "I will create the project"), you MUST immediately make the corresponding tool call in the same response. Never end your turn with a promise of future action — execute it now.
Keep working until the task is actually complete. Do not stop with a summary of what you plan to do next time. If you have tools available that can accomplish the task, use them instead of telling the user what you would do.
Every response should either (a) contain tool calls that make progress, or (b) deliver a final result to the user. Responses that only describe intentions without acting are not acceptable.

## Using your tools
- Use the RIGHT tool for each job. Do NOT use bash when a dedicated tool exists:
  - To read files: use read_file, NOT cat/head/tail
  - To write files: use write_file, NOT echo/cat with redirection
  - To search file content: use grep, NOT bash grep
- Reserve bash exclusively for shell commands that have no dedicated tool (git, curl, npm, etc.)

## Memory
- memory_save: appends to today's file (workspace/memory/yyyy-MM-dd.md). Read the file first before appending to avoid duplicates. Record things worth remembering — important facts, interesting events, meaningful moments. Not timestamps and routine logs.
- memory_update_index: overwrites MEMORY.md. Read it first before updating. For persistent long-term facts. Keep it concise.
- memory_search: search past daily memory files when the user refers to something from previous days.
- Save silently. Do NOT mention saving memory unless asked.

`;

function loadFile(name: string): string {
  try {
    return readFileSync(resolve(import.meta.dirname ?? process.cwd(), "..", "workspace", name), "utf-8");
  } catch {
    return "";
  }
}

function buildSystemPrompt(extra?: string): string {
  const date = `Current date: ${new Date().toISOString().split("T")[0]}`;
  const persona = loadFile("FURET.md");
  const memory = loadFile("MEMORY.md");
  const memorySection = memory ? `\n## Long-term Memory\n${memory}` : "";
  return [SYSTEM_INSTRUCTIONS, date, persona, memorySection, extra].filter(Boolean).join("\n");
}

// --- Tool definitions (OpenAI format → Anthropic format conversion) ---
const OPENAI_TOOLS = [
  bashDefinition, readFileDefinition, writeFileDefinition,
  weatherDefinition,
  memorySaveDefinition, memorySearchDefinition, memoryListDefinition, memoryUpdateIndexDefinition,
  cronCreateDefinition, cronListDefinition, cronDeleteDefinition, cronToggleDefinition,
  reminderCreateDefinition, reminderListDefinition, reminderDeleteDefinition,
  discordFetchMessageDefinition,
];

// 轉成 Anthropic tool format
const TOOLS = OPENAI_TOOLS.map(t => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

// 加上 Anthropic server-side web_search
const ALL_TOOLS = [
  ...TOOLS,
  { type: "web_search_20250305", name: "web_search", max_uses: 5 },
];

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "bash": return executeBash(args as { command: string });
    case "read_file": return executeReadFile(args as { path: string });
    case "write_file": return executeWriteFile(args as { path: string; content: string });
    case "get_weather": return executeWeather(args as { city: string; lang?: string });
    case "memory_save": return executeMemorySave(args as { content: string });
    case "memory_search": return executeMemorySearch(args as { query: string });
    case "memory_list": return executeMemoryList();
    case "memory_update_index": return executeMemoryUpdateIndex(args as { content: string });
    case "cron_create": return executeCronCreate(args as { name: string; schedule: string; prompt: string });
    case "cron_list": return executeCronList();
    case "cron_delete": return executeCronDelete(args as { id: string });
    case "cron_toggle": return executeCronToggle(args as { id: string; enabled: boolean });
    case "reminder_create": return executeReminderCreate(args as { name: string; trigger_at: string; prompt: string });
    case "reminder_list": return executeReminderList();
    case "reminder_delete": return executeReminderDelete(args as { id: string });
    case "discord_fetch_message": return executeDiscordFetchMessage(args as { channel_id: string; message_id: string });
    default: return `Unknown tool: ${name}`;
  }
}

// --- Anthropic API call ---
async function callAnthropic(system: string, messages: AnthropicMessage[]): Promise<{
  content: ContentBlock[];
  stop_reason: string;
}> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system,
      messages,
      tools: ALL_TOOLS,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText}`);
  }
  return res.json() as Promise<{ content: ContentBlock[]; stop_reason: string }>;
}

// --- Agent loop ---
export async function ask(prompt: string | null, options: AgentOptions = {}): Promise<AgentResponse> {
  const startTime = Date.now();
  const maxTurns = options.maxTurns ?? 10;
  const toolsUsed: ToolActivity[] = [];
  const collectedTexts: string[] = [];

  logger.info({ prompt: prompt?.slice(0, 200) ?? "(session tail)" }, "query start");

  const session = options.session;

  // 若有新 prompt，append 進 session
  if (prompt !== null) {
    session?.append({ role: "user", content: prompt });
  }

  // 組 messages（Anthropic 格式：system 分離，messages 只有 user/assistant）
  const systemPrompt = buildSystemPrompt(options.systemPrompt);
  const sessionMessages = (session?.getMessages() ?? []) as AnthropicMessage[];
  const messages: AnthropicMessage[] = [
    ...sessionMessages,
    ...(prompt !== null && !session ? [{ role: "user" as const, content: prompt }] : []),
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callAnthropic(systemPrompt, messages);

    logger.info({
      turn,
      stop_reason: response.stop_reason,
      blocks: response.content.map(b => b.type),
    }, "agent turn");

    // 收集文字 + tool calls
    const textBlocks: string[] = [];
    const toolUseBlocks: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];

    for (const block of response.content) {
      if (block.type === "text") textBlocks.push(block.text);
      if (block.type === "tool_use") toolUseBlocks.push(block);
      if (block.type === "web_search_tool_result") {
        toolsUsed.push({ tool: "web_search", input: {} });
        logger.info("server-side web_search used");
        options.onToolUse?.("web_search", {});
      }
    }

    if (textBlocks.length > 0) collectedTexts.push(textBlocks.join(""));

    // 把 assistant 回覆加進 messages
    messages.push({ role: "assistant", content: response.content });

    // 沒有 tool call → 結束
    if (toolUseBlocks.length === 0) {
      session?.append({ role: "assistant", content: response.content });
      const durationMs = Date.now() - startTime;
      const finalText = collectedTexts.join("\n\n");
      logger.info({ durationMs, toolsUsed: toolsUsed.map(t => t.tool), textLength: finalText.length }, "query done");
      return { text: finalText, toolsUsed, durationMs };
    }

    // 執行 tool calls
    const toolResults: ContentBlock[] = [];
    for (const toolBlock of toolUseBlocks) {
      toolsUsed.push({ tool: toolBlock.name, input: toolBlock.input });
      logger.info({ tool: toolBlock.name, input: toolBlock.input }, "tool call");
      options.onToolUse?.(toolBlock.name, toolBlock.input);
      const result = await executeTool(toolBlock.name, toolBlock.input);
      logger.debug({ tool: toolBlock.name, result: result.slice(0, 500) }, "tool result");
      toolResults.push({ type: "tool_result", tool_use_id: toolBlock.id, content: result });
    }

    // tool results 作為 user message 送回（Anthropic 格式）
    const userToolMsg: AnthropicMessage = { role: "user", content: toolResults };
    messages.push(userToolMsg);

    if (session) {
      session.append({ role: "assistant", content: response.content });
      session.append(userToolMsg);
    }
  }

  const durationMs = Date.now() - startTime;
  logger.error({ maxTurns }, "max turns reached");
  return { text: "達到最大回合數限制。", toolsUsed, durationMs };
}
