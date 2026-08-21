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
  | { type: "code_execution_tool_result"; content: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  time?: string;       // MM/DD HH:mm
  msgId?: string;      // Discord message ID
  replyTo?: string;    // replied message ID
  /** True only for the synthetic summary inserted by Session.compact(). */
  isCompactSummary?: boolean;
  /** True only for the one-time onboarding context injected on first session in a fresh workspace. */
  isOnboarding?: boolean;
};

// --- Token Usage ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Immutable record of a locally executed tool call. Full input/output remain in the
 * session file for audit and later inspection; only a concise projection is sent
 * back to the model on subsequent turns. */
export interface ToolHistoryEvent {
  id: string;
  time: string;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
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
  /** 工具在這次請求中排隊的檔案附件（由 ask() 從 request context 收集） */
  attachments: string[];
}

export type ProgressEvent =
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_end"; toolCallId: string; isError: boolean }
  /**
   * Agent 在 tool call 之間產生的文字。只進 session，不在 ask() 的回傳值裡，
   * 需要靠這個事件才看得到。純過場，最終回覆會覆蓋掉。
   */
  | { type: "text"; text: string };

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
  /** 發話的 Discord 使用者 ID，供 tools.bash_allowed_users 判定用 */
  userId?: string;
}
