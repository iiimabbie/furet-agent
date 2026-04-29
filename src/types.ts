// --- Tool ---

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// --- Anthropic API ---

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "web_search_tool_result"; content: Array<{ type: string; url?: string; title?: string; encrypted_content?: string }> }
  | { type: "web_fetch_tool_result"; content: unknown }
  | { type: "code_execution_tool_result"; content: unknown };

export type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  time?: string;       // MM/DD HH:mm
  msgId?: string;      // Discord message ID
  replyTo?: string;    // replied message ID
};

// --- Token Usage ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// --- Agent ---

export interface ToolActivity {
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentResponse {
  text: string;
  toolsUsed: ToolActivity[];
  durationMs: number;
  usage: TokenUsage;
}

export type ProgressEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_end"; toolCallId: string; isError: boolean };

export type TriggerSource = "cli" | "discord-owner" | "discord-other" | "cron" | "reminder" | "journal" | "unknown";

export interface AgentOptions {
  systemPrompt?: string;
  maxTurns?: number;
  model?: string;
  session?: import("./session.js").Session;
  onToolUse?: (tool: string, input: Record<string, unknown>) => void;
  onProgress?: (event: ProgressEvent) => void;
  images?: string[];
  trigger?: TriggerSource;
}
