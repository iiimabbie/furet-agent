import { OpenAIChatAdapter } from "./adapters/openai-chat.js";
import type { LlmAdapter, LlmProfile, LlmRequest, LlmResponse } from "./types.js";

const adapters: Partial<Record<LlmProfile["protocol"], LlmAdapter>> = {
  openai_chat_completions: new OpenAIChatAdapter(),
};

export async function generateLlmResponse(request: LlmRequest, profile: LlmProfile): Promise<LlmResponse> {
  const adapter = adapters[profile.protocol];
  if (!adapter) throw new Error(`LLM protocol is not available for interactive requests: ${profile.protocol}`);
  return adapter.generate(request, profile);
}
