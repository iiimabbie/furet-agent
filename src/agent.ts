import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type, getModels, type Model } from "@mariozechner/pi-ai";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { ROOT, SESSIONS_DIR } from "./paths.js";
import { buildSystemPrompt, MEMORY_HOOK } from "./prompt.js";
import { executeTool, registeredTools } from "./tools/registry.js";
import type { AgentOptions, AgentResponse, TokenUsage, ToolActivity, Message } from "./types.js";

const PI_SESSIONS_DIR = resolve(SESSIONS_DIR, "pi");

function nowTimestamp(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).slice(5, 16).replace("-", "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function buildPromptText(prompt: string | null, options: AgentOptions): string {
  const sessionMessages = options.session?.getMessages() ?? [];
  const latestSessionUser = sessionMessages.length > 0 ? sessionMessages[sessionMessages.length - 1] : null;

  let baseText = "";
  if (prompt !== null) {
    baseText = prompt;
  } else if (latestSessionUser?.role === "user" && typeof latestSessionUser.content === "string") {
    baseText = latestSessionUser.content;
  }

  const imageLines = (options.images ?? []).map((url, index) => `- [${index + 1}] ${url}`);
  const imagesSection = imageLines.length > 0 ? `\n\nAttached images:\n${imageLines.join("\n")}` : "";

  return `${baseText}${MEMORY_HOOK}${imagesSection}`;
}

function sanitizeSessionId(input: string): string {
  return encodeURIComponent(input);
}

/** 搬家腳本：從舊版 json 遷移至 pi SDK jsonl */
function migrateLegacySession(sessionId: string, jsonlPath: string): void {
  const legacyPath = resolve(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(legacyPath)) return;

  try {
    const data = JSON.parse(readFileSync(legacyPath, "utf-8"));
    const legacyMsgs: Message[] = data.messages ?? [];
    if (legacyMsgs.length === 0) return;

    logger.info({ sessionId, count: legacyMsgs.length }, "migrating legacy session to pi jsonl");

    const manager = SessionManager.create(ROOT, PI_SESSIONS_DIR);
    manager.setSessionFile(jsonlPath);

    for (const msg of legacyMsgs) {
      if (typeof msg.content !== "string") continue;
      const role = msg.role === "assistant" ? "assistant" : "user";
      if (role === "user") {
        manager.appendMessage({
          role: "user",
          content: msg.content,
          timestamp: Date.now(),
        });
      } else {
        manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
          api: "legacy",
          provider: "legacy",
          model: "legacy",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        } as any);
      }
    }
    renameSync(legacyPath, legacyPath + ".migrated");
    logger.info({ sessionId }, "migration completed and legacy session renamed");
  } catch (err) {
    logger.warn({ sessionId, err: (err as Error).message }, "failed to migrate legacy session");
  }
}

function sessionManagerFor(sessionId: string): SessionManager {
  mkdirSync(PI_SESSIONS_DIR, { recursive: true });
  const filename = `${sanitizeSessionId(sessionId)}.jsonl`;
  const sessionFile = resolve(PI_SESSIONS_DIR, filename);

  if (!existsSync(sessionFile)) {
    migrateLegacySession(sessionId, sessionFile);
  }

  if (existsSync(sessionFile)) {
    return SessionManager.open(sessionFile, PI_SESSIONS_DIR, ROOT);
  }

  const manager = SessionManager.create(ROOT, PI_SESSIONS_DIR);
  manager.setSessionFile(sessionFile);
  return manager;
}

function resolveAnthropicModel(): Model<"anthropic-messages"> {
  const config = loadConfig();
  const availableModels = getModels("anthropic");
  const baseModel = availableModels.find(model => model.id === config.llm.currentModel) ?? availableModels[0];
  if (!config.llm.base_url) return baseModel;

  return {
    ...baseModel,
    baseUrl: config.llm.base_url,
  };
}

function extractAssistantResult(messages: AgentMessage[], startIndex: number): { text: string; usage: TokenUsage } {
  let text = "";
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;

    const messageText = message.content
      .filter(isTextBlock)
      .map(block => block.text)
      .join("");

    if (messageText) {
      text = messageText;
    }

    if (isRecord(message.usage)) {
      usage.inputTokens += typeof message.usage.input === "number" ? message.usage.input : 0;
      usage.outputTokens += typeof message.usage.output === "number" ? message.usage.output : 0;
    }
  }

  return { text, usage };
}

function createBuiltinToolsExtension(options: AgentOptions): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    for (const tool of registeredTools) {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: Type.Unsafe(tool.parameters),
        async execute(toolCallId, params) {
          const input = isRecord(params) ? params : {};
          let result: string;
          let isError = false;
          options.onProgress?.({ type: "tool_start", toolCallId, toolName: tool.name });
          try {
            result = await executeTool(tool.name, input);
          } catch (err) {
            result = `Error: ${(err as Error).message}`;
            isError = true;
            logger.warn({ tool: tool.name, err: (err as Error).message }, "tool execution error (recovered)");
          }
          options.onProgress?.({ type: "tool_end", toolCallId, isError });
          return {
            content: [{ type: "text", text: result }],
            details: {},
          };
        },
      });
    }

    pi.on("before_agent_start", (event) => {
      // Prioritize the user's original system prompt and instructions from AGENT.md / SOUL.md.
      // buildSystemPrompt combines these along with memory and people context.
      const legacySystemPrompt = buildSystemPrompt(options.systemPrompt);

      // event.systemPrompt (from pi framework) contains specific instructions for the SDK tools.
      const layeredPrompt = [
        legacySystemPrompt,
        `--- Framework Instructions ---\n${event.systemPrompt}`,
      ].filter(Boolean).join("\n\n");

      return { systemPrompt: layeredPrompt };
    });
  };
}

export async function ask(prompt: string | null, options: AgentOptions = {}): Promise<AgentResponse> {
  const startTime = Date.now();
  const toolsUsed: ToolActivity[] = [];
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const logicalSessionId = options.sessionId ?? options.session?.id ?? "global";

  logger.info({ prompt: prompt?.slice(0, 200) ?? "(session tail)", sessionId: logicalSessionId }, "query start");

  if (prompt !== null) {
    options.session?.append({ role: "user", content: prompt, time: nowTimestamp() });
  }

  const authStorage = AuthStorage.inMemory();
  const config = loadConfig();
  if (config.llm.api_key) {
    authStorage.setRuntimeApiKey("anthropic", config.llm.api_key);
  }
  const modelRegistry = ModelRegistry.create(authStorage);
  const resourceLoader = new DefaultResourceLoader({
    cwd: ROOT,
    agentDir: getAgentDir(),
    extensionFactories: [createBuiltinToolsExtension(options)],
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const promptText = buildPromptText(prompt, options);
  const { session } = await createAgentSession({
    cwd: ROOT,
    authStorage,
    modelRegistry,
    model: resolveAnthropicModel(),
    sessionManager: sessionManagerFor(logicalSessionId),
    tools: registeredTools.map(tool => tool.name),
    resourceLoader,
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const input = isRecord(event.args) ? event.args : {};
      toolsUsed.push({ tool: event.toolName, input });
      options.onToolUse?.(event.toolName, input);
      logger.info({ tool: event.toolName, input }, "tool call");
      return;
    }
  });

  let finalText = "";
  const startIndex = session.messages.length;
  try {
    session.setActiveToolsByName(registeredTools.map(tool => tool.name));
    await session.prompt(promptText);

    const result = extractAssistantResult(session.messages, startIndex);
    finalText = result.text;
    totalUsage.inputTokens += result.usage.inputTokens;
    totalUsage.outputTokens += result.usage.outputTokens;

    if (finalText) {
      options.session?.append({ role: "assistant", content: finalText, time: nowTimestamp() });
    }
    options.session?.addUsage(totalUsage);
  } finally {
    unsubscribe();
    session.dispose();
  }

  const durationMs = Date.now() - startTime;
  logger.info({ durationMs, toolsUsed: toolsUsed.map(t => t.tool), textLength: finalText.length, usage: totalUsage }, "query done");
  return { text: finalText, toolsUsed, durationMs, usage: totalUsage };
}

export function getPiSessionDirectory(): string {
  mkdirSync(PI_SESSIONS_DIR, { recursive: true });
  return PI_SESSIONS_DIR;
}

export function archivePiSession(sessionId: string): void {
  const sessionDir = getPiSessionDirectory();
  const archiveDir = resolve(sessionDir, "archive");
  const fileName = `${sanitizeSessionId(sessionId)}.jsonl`;
  const source = resolve(sessionDir, fileName);
  if (!existsSync(source)) return;

  mkdirSync(archiveDir, { recursive: true });
  const timestamp = Date.now();
  const destination = resolve(archiveDir, `${sanitizeSessionId(sessionId)}-${timestamp}.jsonl`);
  renameSync(source, destination);
}
