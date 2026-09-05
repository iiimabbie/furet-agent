import assert from "node:assert/strict";
import { test } from "node:test";
import { compactSession } from "../src/agent.js";
import { RunStoppedError } from "../src/active-runs.js";
import type { LlmProfile } from "../src/llm/types.js";
import type { Message } from "../src/types.js";

const profile: LlmProfile = {
  name: "test",
  protocol: "openai_chat_completions",
  baseUrl: "https://example.invalid/v1",
  apiKey: "test-only",
  auth: "bearer",
  model: "test-model",
  reasoningEffort: "default",
  tokenLimitField: "max_completion_tokens",
  capabilities: {
    vision: false,
    function_tools: false,
    responses: false,
    hosted_web_search: false,
    hosted_image_generation: false,
    hosted_code_execution: false,
  },
};

test("active-run cancellation aborts compaction and prevents session mutation", async (t) => {
  const messages: Message[] = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `message ${index}`,
  }));
  let archiveCalls = 0;
  let compactCalls = 0;
  const session = {
    id: "test-compaction-cancellation",
    getMessages: () => messages,
    archiveForCompaction: () => { archiveCalls++; return true; },
    compact: () => { compactCalls++; },
  };

  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    fetchCalls++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });

  const controller = new AbortController();
  const pending = compactSession(
    session as unknown as Parameters<typeof compactSession>[0],
    profile,
    controller.signal,
  );
  const reason = new RunStoppedError();
  controller.abort(reason);

  await assert.rejects(pending, error => error === reason);
  assert.equal(fetchCalls, 1);
  assert.equal(archiveCalls, 0);
  assert.equal(compactCalls, 0);
});
