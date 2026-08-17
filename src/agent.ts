import { logger } from "./logger.js";
import { loadConfig } from "./config.js";
import { buildSystemPrompt, MEMORY_HOOK } from "./prompt.js";
import { anthropicTools, executeTool } from "./tools/registry.js";
import { runWithContext, drainAttachments } from "./tools/context.js";
import { searchVectors } from "./embedding.js";
import { stamp } from "./utils/time.js";
import type { ContentBlock, Message, TokenUsage, ToolActivity, AgentResponse, AgentOptions } from "./types.js";

/** 清除 API 回傳 content blocks 中的多餘欄位（如 caller），只保留我們定義的欄位 */
function sanitizeContent(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map(b => {
    switch (b.type) {
      case "text": return { type: b.type, text: b.text };
      case "thinking": return { type: b.type, thinking: b.thinking, ...(b.signature ? { signature: b.signature } : {}) };
      case "tool_use": return { type: b.type, id: b.id, name: b.name, input: b.input };
      case "tool_result": return { type: b.type, tool_use_id: b.tool_use_id, content: b.content };
      default: return b;
    }
  });
}

/**
 * 移除 thinking blocks，不存進 session。
 *
 * thinking block 的 `signature` 是模型端的加密推理酬載（gpt-5.6-sol 走 router 時是
 * Fernet token，約 1.3KB），`thinking` 欄位本身只是一行標題。它只在「同一輪內接著
 * 回送 tool_result」時有用；跨輪重送等於每輪多背幾百個 token 卻換不到東西——歷史
 * 裡配對的 tool_use 本來就會被濾掉，推理接續性早就斷了。
 */
function stripThinking(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter(b => b.type !== "thinking");
}

/** tool_use input 裡最能代表這次呼叫的欄位，依序找 */
const TOOL_ARG_KEYS = ["path", "file", "file_path", "command", "query", "pattern", "name", "id", "city", "url", "prompt"];

/** 從 tool_use 的 input 抓一個短標識，抓不到就回空字串 */
function toolArgHint(input: Record<string, unknown>): string {
  const key = TOOL_ARG_KEYS.find(k => typeof input[k] === "string" && input[k])
    ?? Object.keys(input).find(k => typeof input[k] === "string" && input[k]);
  if (!key) return "";
  const v = String(input[key]).replace(/\s+/g, " ").trim();
  return v.length > 50 ? v.slice(0, 50) + "…" : v;
}

/**
 * 把 assistant message 裡的 tool_use blocks 折成一行紀錄，**以 `[System]` user message 送出**。
 *
 * tool_use 不能原樣送回 API（session 不存 tool_result，沒有配對就是無效結構），
 * 但整個丟掉的話模型跨輪就完全不知道自己做過什麼——它只看得到最後那句回覆。
 *
 * 這行字**不能放進 assistant 訊息裡**。掛在那裡的話，模型看到的是一段宣稱呼叫過工具、
 * 卻沒有對應 tool_use block 的散文，正好撞上 AGENT.md 的 "Never fabricate tool results"，
 * 會判定成自己捏造的，下一輪主動否認並道歉。由 harness 用 `[System]` 的 user message
 * 陳述時說話的人是系統，不是 agent 自己，就沒有這個問題。
 */
function summarizeToolUse(blocks: ContentBlock[]): string {
  const calls = blocks
    .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map(b => {
      const hint = toolArgHint(b.input ?? {});
      return hint ? `${b.name}(${hint})` : b.name;
    });
  if (calls.length === 0) return "";
  return `[System] Tools actually executed in the preceding assistant turn (recorded by the harness, tool results omitted): ${calls.join(", ")}`;
}

/** 粗估 message 的 token 數（JSON 長度 / 4） */
function estimateTokens(msg: { role: string; content: string | ContentBlock[] }): number {
  const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  return Math.ceil(text.length / 4);
}

/**
 * 從 session messages 中取出符合 token 上限的歷史，確保：
 * 1. tool_use / tool_result 配對不被拆散
 * 2. 從最新的往回取，優先保留近期對話
 */
function trimToTokenBudget(messages: Message[], maxTokens: number): Message[] {
  // 從後往前累加 token，找到能放進預算的起點
  let totalTokens = 0;
  let startIdx = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i]);
    if (totalTokens + tokens > maxTokens) break;
    totalTokens += tokens;
    startIdx = i;
  }

  // 保底：就算單則訊息本身就超過預算，也至少留最後一則，
  // 否則會回傳空陣列，送出去的 messages 是空的 → API 400
  if (startIdx >= messages.length && messages.length > 0) {
    startIdx = messages.length - 1;
  }

  // 往前推確保不拆散 tool_use/tool_result 配對：
  // 如果起點是一則 user message 且 content 是 tool_result 陣列，
  // 它的配對 assistant（含 tool_use）在前一則，必須一起帶上
  while (startIdx > 0) {
    const msg = messages[startIdx];
    if (msg.role === "user" && Array.isArray(msg.content) &&
        (msg.content as ContentBlock[]).some(b => b.type === "tool_result")) {
      startIdx--;
    } else {
      break;
    }
  }

  return messages.slice(startIdx);
}

/**
 * 取最後一則純文字 user message 的內容（用於自動記憶召回的 query）。
 * 剝掉 formatIncomingMessage 加的 `[msg:id 時間] <@id>(username｜暱稱):` 前綴——
 * 那些是路由用的中繼資料，留著只會稀釋語意搜尋的訊號。
 */
function lastUserText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string") {
      const stripped = m.content
        .replace(/^\[msg:\S+\s[^\]]*\]\s*/, "")
        .replace(/^<@!?\d+>(?:\([^)]*\))?:\s*/, "")
        .replace(/^\(reply to msg:\d+\)\s*/, "")
        .trim();
      return stripped || m.content;
    }
  }
  return null;
}

const PUSH_CONTEXT_NOTE = "[System] The following messages were proactively pushed to this channel by scheduled tasks, with no user message before them.";

/**
 * Anthropic API 要求 messages 第一則必須是 user role。
 * 但 session 開頭可能是 assistant——cron/reminder 主動推播時
 * sendAndPersist() 會直接 append assistant，或 trim 從中間切開。
 *
 * 開頭是 assistant 時，補一則 user 說明而不是把它們丟掉：
 * 那些內容是真的推播出去過的對話紀錄，砍掉會讓 agent 失去上下文。
 */
function ensureUserFirst(messages: Message[]): Message[] {
  if (messages.length === 0 || messages[0].role === "user") return messages;
  return [{ role: "user", content: PUSH_CONTEXT_NOTE }, ...messages];
}

function extractText(blocks: ContentBlock[]): string {
  return blocks.filter((b): b is ContentBlock & { type: "text" } => b.type === "text").map(b => b.text).join("");
}

/** Fetch a single image URL and return a base64 image block for the Anthropic API */
async function fetchImageAsBase64(url: string): Promise<ContentBlock | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "image fetch failed (non-OK status)");
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "image/png";
    // Normalise media type — Anthropic accepts image/jpeg, image/png, image/gif, image/webp
    const media_type = contentType.split(";")[0].trim();
    const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
    if (!ALLOWED_TYPES.has(media_type)) {
      logger.warn({ url, media_type }, "image fetch returned unsupported content-type");
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const data = buf.toString("base64");
    return {
      type: "image",
      source: { type: "base64", media_type, data },
    } as unknown as ContentBlock;
  } catch (err) {
    logger.warn({ url, err: (err as Error).message }, "image fetch failed (exception)");
    return null;
  }
}

/** 組裝 user message content：純文字 or 文字+圖片 (base64) */
async function buildUserContent(text: string, images?: string[]): Promise<string | ContentBlock[]> {
  if (!images || images.length === 0) return text;

  const blocks = await Promise.all(images.map(url => fetchImageAsBase64(url)));
  const validBlocks = blocks.filter((b): b is ContentBlock => b !== null);
  const failedCount = images.length - validBlocks.length;

  if (failedCount > 0) {
    logger.warn({ total: images.length, failed: failedCount }, "some images could not be fetched");
  }

  if (validBlocks.length === 0) {
    // All images failed — add honesty hint so the model knows it has no visual data
    const honestyNote = "\n\n[System note: The user attached image(s) but they could not be loaded. You have NO visual information. Do not guess or hallucinate image contents — honestly tell the user you cannot see the image.]";
    return text + honestyNote;
  }

  const content: ContentBlock[] = [
    ...validBlocks,
    { type: "text" as const, text: failedCount > 0
      ? text + `\n\n[System note: ${failedCount} of ${images.length} image(s) failed to load. Only describe what you can actually see in the successfully loaded images. If you're unsure about visual details, say so honestly.]`
      : text },
  ];
  return content;
}

function nowTimestamp(): string {
  return stamp();
}


async function callAnthropic(system: string, messages: Message[], model?: string, withTools = true): Promise<{
  content: ContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}> {
  // 每次都重讀 config —— base_url / api_key 跟 currentModel 一樣要能熱更新
  const { llm } = loadConfig();
  const res = await fetch(`${llm.base_url || "https://api.anthropic.com/v1"}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": llm.api_key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model ?? llm.currentModel,
      max_tokens: 8192,
      system,
      messages,
      ...(withTools ? { tools: anthropicTools } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText}`);
  }
  return res.json() as Promise<{ content: ContentBlock[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number } }>;
}

const COMPACT_THRESHOLD = 0.8; // 80% of maxContextTokens triggers compaction
const COMPACT_KEEP_RECENT = 10; // keep last 10 messages after compaction

/** 壓縮 session：讓 AI 摘要舊對話，替換前半段 */
export async function compactSession(session: import("./session.js").Session, model?: string): Promise<string | null> {
  const messages = session.getMessages();
  if (messages.length <= COMPACT_KEEP_RECENT) return null;

  const toSummarize = messages.slice(0, -COMPACT_KEEP_RECENT);
  const textParts = toSummarize.map(m => {
    if (typeof m.content === "string") return `${m.role}: ${m.content}`;
    const blocks = m.content as ContentBlock[];
    const text = blocks.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("");
    return text ? `${m.role}: ${text}` : null;
  }).filter(Boolean);

  if (textParts.length === 0) return null;

  const compactSystem = "Summarize this conversation concisely. Keep key facts, decisions, and context. Same language as the conversation. Max 500 words.";
  const compactMessages = [{ role: "user" as const, content: textParts.join("\n") }];

  try {
    const response = await callAnthropic(compactSystem, compactMessages as Message[], model, false);
    const summary = extractText(response.content as ContentBlock[]);
    if (summary) {
      session.compact(summary, COMPACT_KEEP_RECENT);
      logger.info({ sessionId: session.id, summarizedMessages: toSummarize.length, summaryLength: summary.length }, "compaction done");
      return summary;
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, "compaction failed");
  }
  return null;
}

/**
 * 執行一次 agent 請求。
 *
 * 整段包在獨立的 request context 裡，讓 trigger（權限判定）跟工具排隊的附件
 * 不會被並行的 cron / reminder / 其他使用者請求互相污染。
 */
export function ask(prompt: string | null, options: AgentOptions = {}): Promise<AgentResponse> {
  return runWithContext(options.trigger ?? "unknown", options.userId, () => askInContext(prompt, options));
}

async function askInContext(prompt: string | null, options: AgentOptions = {}): Promise<AgentResponse> {
  const startTime = Date.now();
  const maxTurns = options.maxTurns ?? 50;
  const toolsUsed: ToolActivity[] = [];
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  logger.info({ prompt: prompt?.slice(0, 200) ?? "(session tail)", trigger: options.trigger }, "query start");

  const session = options.session;

  if (prompt !== null) {
    session?.append({ role: "user", content: prompt, time: nowTimestamp() });
  }

  let systemPrompt = buildSystemPrompt(options.systemPrompt);
  logger.info({ systemPromptLength: systemPrompt.length, hasPersona: systemPrompt.includes("<persona>"), hasMemory: systemPrompt.includes("<memory>"), first500: systemPrompt.slice(0, 500) }, "system prompt check");

  // 自動記憶召回：用使用者訊息搜尋相關記憶，注入 system prompt。
  // Discord 路徑一律用 ask(null)（訊息已經 append 進 session），
  // 所以 prompt 為 null 時改拿 session 最後一則 user message 當 query。
  const recallQuery = prompt ?? lastUserText(session?.getMessages() ?? []);
  if (recallQuery) {
    try {
      const recalled = await searchVectors(recallQuery, 3, {
        excludeFiles: ["MEMORY.md", "PEOPLE.md"],
        excludeRecentDays: 2,
      });
      if (recalled.length > 0) {
        const recallBlock = recalled.map(r => `- [${r.file}] ${r.text}`).join("\n");
        systemPrompt += `\n\n## Recalled Memories\nThe following memories are automatically recalled based on the current message. Use them naturally if relevant — do not mention this mechanism to the user.\n${recallBlock}`;
        logger.debug({ count: recalled.length, topScore: recalled[0].score.toFixed(2) }, "auto memory recall");
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "auto memory recall failed, continuing without");
    }
  }

  type ApiMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };

  // 從 session 取歷史，用 token budget 控制上限
  const maxContextTokens = loadConfig().llm.maxContextTokens;

  // 自動 compaction：session token 超過閾值時壓縮
  if (session) {
    const totalTokens = session.getMessages().reduce((sum, m) => sum + estimateTokens(m), 0);
    if (totalTokens > maxContextTokens * COMPACT_THRESHOLD) {
      logger.info({ totalTokens, threshold: maxContextTokens * COMPACT_THRESHOLD }, "auto compaction triggered");
      await compactSession(session, options.model);
    }
  }

  const allSessionMessages = session?.getMessages() ?? [];
  const sessionMessages = ensureUserFirst(trimToTokenBudget(allSessionMessages, maxContextTokens));

  // 標準 multi-turn：直接展開 session messages 送 API
  const messages: ApiMessage[] = [];

  // Memory hook 只在每 N 則 user message 時附加（定期 nudge，非每輪）
  const MEMORY_NUDGE_INTERVAL = 5;
  const userMsgCount = session ? allSessionMessages.filter(m => m.role === "user" && typeof m.content === "string").length : 1;
  const shouldNudge = userMsgCount % MEMORY_NUDGE_INTERVAL === 0 || userMsgCount <= 1;
  const hook = shouldNudge ? MEMORY_HOOK : "";

  if (session) {
    // 有 session：歷史已在 session 中（含 thinking + tool_use，但不含 tool_result）
    // 送 API 時：含 tool_use 的 assistant message 要過濾掉 tool_use blocks（因為沒有配對的 tool_result）
    for (let i = 0; i < sessionMessages.length; i++) {
      const m = sessionMessages[i];
      const isLast = i === sessionMessages.length - 1;

      if (m.role === "assistant" && Array.isArray(m.content)) {
        // tool_use 不能原樣送（沒有配對的 tool_result），但整個丟掉會讓模型看不到
        // 自己上一輪做過什麼，所以折成一行文字摘要保留行為紀錄。
        // thinking 不存進 session（見 stripThinking），這裡再濾一次以相容既有的 session 檔
        const blocks = m.content as ContentBlock[];
        const apiBlocks = blocks.filter(b => b.type !== "tool_use" && b.type !== "thinking");
        if (apiBlocks.length > 0) messages.push({ role: m.role, content: apiBlocks });
        const recap = summarizeToolUse(blocks);
        if (recap) messages.push({ role: "user", content: recap });
      } else if (isLast && m.role === "user" && typeof m.content === "string") {
        messages.push({ role: m.role, content: await buildUserContent(m.content + hook, options.images) });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
  } else if (prompt !== null) {
    // 無 session（單次推理，如 cron/reminder）
    messages.push({ role: "user", content: await buildUserContent(prompt + hook, options.images) });
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callAnthropic(systemPrompt, messages, options.model);

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
      // 當下這一輪要帶 thinking：接著回送 tool_result 時，reasoning model 需要它
      messages.push({ role: "assistant", content: cleanContent });
      // 存進 session：text + tool_use（不存 thinking / tool_result）
      const persisted = stripThinking(cleanContent);
      if (persisted.length > 0) {
        session?.append({ role: "assistant", content: persisted, time: nowTimestamp() });
      }
    }

    // 沒有 tool call → 最後一輪
    if (toolUseBlocks.length === 0) {
      const finalText = extractText(cleanContent);

      // 如果沒有文字回覆（agent 只做了 tool call），強制再跑一輪要求回話
      if (!finalText && turn < maxTurns - 1) {
        messages.push({ role: "user", content: "[System] Please reply to the user with a text response." });
        continue;
      }

      const durationMs = Date.now() - startTime;
      session?.addUsage(totalUsage);
      logger.info({ durationMs, toolsUsed: toolsUsed.map(t => t.tool), textLength: finalText.length, usage: totalUsage }, "query done");
      return { text: finalText, toolsUsed, durationMs, usage: totalUsage, attachments: drainAttachments() };
    }

    // 在執行工具前送出，順序才與 agent 的實際動作一致。
    // 這一輪有 tool call，這段文字不會進入 ask() 的回傳值。
    const interimText = extractText(cleanContent).trim();
    if (interimText) options.onProgress?.({ type: "text", text: interimText });

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
  return { text: "達到最大回合數限制。", toolsUsed, durationMs, usage: totalUsage, attachments: drainAttachments() };
}
