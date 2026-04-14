import { query } from "@anthropic-ai/claude-agent-sdk";

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

const DEFAULT_ALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit",
  "Glob", "Grep",
  "WebSearch", "WebFetch",
  "Task",
];

export async function ask(prompt: string, options: AgentOptions = {}): Promise<AgentResponse> {
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
      systemPrompt: options.systemPrompt
        ? { type: "preset", preset: "claude_code", append: options.systemPrompt }
        : { type: "preset", preset: "claude_code" },
      permissionMode: "acceptEdits",
      mcpServers: options.mcpServers as Record<string, never> | undefined,
      resume: options.resume,
    },
  })) {
    const msg = message as Record<string, unknown>;

    if (msg.type === "tool_use") {
      const toolName = (msg.name as string) ?? "unknown";
      const toolInput = (msg.input as Record<string, unknown>) ?? {};
      toolsUsed.push({ tool: toolName, input: toolInput });
      options.onToolUse?.(toolName, toolInput);
    }

    if (msg.type === "result" && msg.subtype === "success") {
      resultText = (msg.result as string) ?? "";
      totalCost = (msg.total_cost_usd as number) ?? 0;
      duration = (msg.duration_ms as number) ?? 0;
      sessionId = msg.session_id as string | undefined;
    }
  }

  return {
    text: resultText,
    cost: totalCost,
    durationMs: duration,
    sessionId,
    toolsUsed,
  };
}
