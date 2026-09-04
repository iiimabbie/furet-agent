import type { Tool } from "../../types.js";

function unavailable(name: string, explanation: string): Tool {
  return {
    name,
    description: `${explanation} This deployment exposes the tool explicitly so capability loss is visible; calling it returns an unavailable result.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => `⚠️ CAPABILITY UNAVAILABLE: ${name} is not configured for the OpenAI-compatible Chat Completions transport in this deployment.`,
  };
}

export const codeExecutionUnavailable = unavailable(
  "code_execution",
  "Run code in a provider-managed sandbox. Host bash is intentionally not substituted because it has a different security boundary.",
);
