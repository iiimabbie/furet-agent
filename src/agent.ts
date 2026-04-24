import { logger } from "./logger.js";
import { loadConfig } from "./config.js";
import { buildSystemPrompt, MEMORY_HOOK } from "./prompt.js";
import { anthropicTools, executeTool, setTrigger } from "./tools/registry.js";
import { searchVectors } from "./embedding.js";
import type { ContentBlock, Message, TokenUsage, ToolActivity, AgentResponse, AgentOptions, ProgressEvent } from "./types.js";

/** 清除 API 回傳 content blocks 中的多餘欄位（如 caller），只保留我們定義的欄位 */
function sanitizeContent(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map(b => {
    switch (b.type) {
      case "text": return { type: b.type, text: b.text };
      case "tool_use": return { type: b.type, id: b.id, name: b.name, input: b.input };
      case "tool_result": return { type: b.type, tool_use_id: b.tool_use_id, content: b.content };
      default: return b;
    }
  });
}

function extractText(blocks: ContentBlock[]): string {
  return blocks.filter((b): b is ContentBlock & { type: "text" } => b.type === "text").map(b => b.text).join("");
}

/** 組裝 user message content：純文字 or 文字+圖片 */
function buildUserContent(text: string, images?: string[]): string | ContentBlock[] {
  if (!images || images.length === 0) return text;
  return [
    ...images.map(url => ({ type: "image" as const, source: { type: "url" as const, url } })),
    { type: "text" as const, text },
  ] as unknown as ContentBlock[];
}

function nowTimestamp(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(5, 16).replace("-", "/");
}


const config = loadConfig();
const API_URL = `${config.llm.base_url || "https://api.anthropic.com/v1"}/messages`;
const API_KEY = config.llm.api_key;

async function callAnthropic(system: string, messages: Message[]): Promise<{
  content: ContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: loadConfig().llm.currentModel,
      max_tokens: 8192,
      system,
      messages,
      tools: anthropicTools,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText}`);
  }
  return res.json() as Promise<{ content: ContentBlock[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number } }>;
}

export async function ask(prompt: string | null, options: AgentOptions = {}): Promise<AgentResponse> {
  const startTime = Date.now();
  const maxTurns = options.maxTurns ?? 50;
  const toolsUsed: ToolActivity[] = [];
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  setTrigger(options.trigger ?? "unknown");
  logger.info({ prompt: prompt?.slice(0, 200) ?? "(session tail)", trigger: options.trigger }, "query start");

  const session = options.session;

  if (prompt !== null) {
    session?.append({ role: "user", content: prompt, time: nowTimestamp() });
  }

  let systemPrompt = buildSystemPrompt(options.systemPrompt);

  // 自動記憶召回：用使用者訊息搜尋相關記憶，注入 system prompt
  if (prompt) {
    try {
      const recalled = await searchVectors(prompt, 5);
      if (recalled.length > 0) {
        const recallBlock = recalled.map(r => `- [${r.file}] ${r.text}`).join("\n");
        systemPrompt += `\n\n## Recalled Memories\nThe following memories are automatically recalled based on the current message. Use them naturally if relevant — do not mention this mechanism to the user.\n${recallBlock}`;
        logger.debug({ count: recalled.length, topScore: recalled[0].score.toFixed(2) }, "auto memory recall");
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "auto memory recall failed, continuing without");
    }
  }

  const sessionMessages = session?.getMessages() ?? [];
  type ApiMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };

  // session 歷史打包成第一則 assistant message，當前訊息是第一則 user message
  const messages: ApiMessage[] = [];
  if (sessionMessages.length > 0) {
    messages.push({ role: "assistant", content: `對話紀錄：\n${JSON.stringify(sessionMessages, null, 2)}` });
  }
  // 當前 prompt（已在 session 裡的不重複加）
  const images = options.images;
  if (prompt !== null && !session) {
    messages.push({ role: "user", content: buildUserContent(prompt + MEMORY_HOOK, images) });
  } else if (session && sessionMessages.length > 0) {
    const last = sessionMessages[sessionMessages.length - 1];
    if (last.role === "user" && typeof last.content === "string") {
      messages.push({ role: "user", content: buildUserContent(last.content + MEMORY_HOOK, images) });
    }
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callAnthropic(systemPrompt, messages);

    logger.info({
      turn,
      stop_reason: response.stop_reason,
      blocks: response.content.map(b => b.type),
    }, "agent turn");

    totalUsage.inputTokens += response.usage.input_tokens;
    totalUsage.outputTokens += response.usage.output_tokens;

    const toolUseBlocks: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];

    for (const block of response.content) {
      if (block.type === "tool_use") toolUseBlocks.push(block);
      if (block.type === "web_search_tool_result") {
        const ssId = `server_web_search_${Date.now()}`;
        toolsUsed.push({ tool: "web_search", input: {} });
        logger.info("server-side web_search used");
        options.onToolUse?.("web_search", {});
        options.onProgress?.({ type: "tool_start", toolCallId: ssId, toolName: "web_search" });
        options.onProgress?.({ type: "tool_end", toolCallId: ssId, isError: false });
      }
      if ((block as Record<string, unknown>).type === "web_fetch_tool_result") {
        const ssId = `server_web_fetch_${Date.now()}`;
        toolsUsed.push({ tool: "web_fetch", input: {} });
        logger.info("server-side web_fetch used");
        options.onToolUse?.("web_fetch", {});
        options.onProgress?.({ type: "tool_start", toolCallId: ssId, toolName: "web_fetch" });
        options.onProgress?.({ type: "tool_end", toolCallId: ssId, isError: false });
      }
      if ((block as Record<string, unknown>).type === "code_execution_tool_result") {
        const ssId = `server_code_exec_${Date.now()}`;
        toolsUsed.push({ tool: "code_execution", input: {} });
        logger.info("server-side code_execution used");
        options.onToolUse?.("code_execution", {});
        options.onProgress?.({ type: "tool_start", toolCallId: ssId, toolName: "code_execution" });
        options.onProgress?.({ type: "tool_end", toolCallId: ssId, isError: false });
      }
    }

    const cleanContent = sanitizeContent(response.content);
    // Skip empty assistant content — some routers (Gemini) reject empty parts
    if (cleanContent.length > 0) {
      messages.push({ role: "assistant", content: cleanContent });
    }

    // 沒有 tool call → 最後一輪
    if (toolUseBlocks.length === 0) {
      let finalText = extractText(cleanContent);

      // 如果沒有文字回覆（agent 只做了 tool call），強制再跑一輪要求回話
      if (!finalText && turn < maxTurns - 1) {
        messages.push({ role: "user", content: "Please reply to the user with a text response." });
        continue;
      }

      if (finalText) {
        session?.append({ role: "assistant", content: finalText, time: nowTimestamp() });
      }
      const durationMs = Date.now() - startTime;
      session?.addUsage(totalUsage);
      logger.info({ durationMs, toolsUsed: toolsUsed.map(t => t.tool), textLength: finalText.length, usage: totalUsage }, "query done");
      return { text: finalText, toolsUsed, durationMs, usage: totalUsage };
    }

    // 有 tool call → 執行，結果只進 messages（不存 session）
    // 用 try-catch 包住每個工具，失敗時把錯誤訊息當成 tool_result 回給 AI，
    // 讓 AI 自行決定如何繼續，而不是讓整個 ask() 直接拋出例外中斷。
    const toolResults: ContentBlock[] = [];
    for (const toolBlock of toolUseBlocks) {
      toolsUsed.push({ tool: toolBlock.name, input: toolBlock.input });
      logger.info({ tool: toolBlock.name, input: toolBlock.input }, "tool call");
      options.onToolUse?.(toolBlock.name, toolBlock.input);
      options.onProgress?.({ type: "tool_start", toolCallId: toolBlock.id, toolName: toolBlock.name });
      let result: string;
      let isError = false;
      try {
        result = await executeTool(toolBlock.name, toolBlock.input);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
        isError = true;
        logger.warn({ tool: toolBlock.name, err: (err as Error).message }, "tool execution error (recovered)");
      }
      options.onProgress?.({ type: "tool_end", toolCallId: toolBlock.id, isError });
      logger.debug({ tool: toolBlock.name, result: result.slice(0, 500) }, "tool result");
      toolResults.push({ type: "tool_result", tool_use_id: toolBlock.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
  }

  const durationMs = Date.now() - startTime;
  session?.addUsage(totalUsage);
  logger.error({ maxTurns }, "max turns reached");
  return { text: "達到最大回合數限制。", toolsUsed, durationMs, usage: totalUsage };
}
