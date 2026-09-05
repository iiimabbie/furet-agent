import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpenAIChatBody, normalizeContent, normalizeFinishReason, normalizeToolCalls } from "../src/llm/adapters/openai-chat.js";
import type { LlmProfile, LlmRequest } from "../src/llm/types.js";

const profile: LlmProfile = {
  name: "test", protocol: "openai_chat_completions", baseUrl: "https://example.invalid/v1",
  apiKey: "test-only", auth: "bearer", model: "test-model", reasoningEffort: "default",
  tokenLimitField: "max_completion_tokens",
  capabilities: { vision: true, function_tools: true, responses: false, hosted_web_search: false, hosted_image_generation: false, hosted_code_execution: false },
};

test("chat request preserves image parts and tool-result correlation", () => {
  const request: LlmRequest = { messages: [
    { role: "system", content: "System" },
    { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image", url: "https://example.invalid/image.png", detail: "low" }] },
    { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "lookup", input: { query: "sample" } }] },
    { role: "tool", toolCallId: "call_1", content: "result" },
  ], tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }] };
  const body = buildOpenAIChatBody(request, profile);
  assert.deepEqual(body.messages, [
    { role: "system", content: "System" },
    { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "https://example.invalid/image.png", detail: "low" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"sample"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "result" },
  ]);
  assert.deepEqual(body.tools, [{ type: "function", function: request.tools![0] }]);
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal("reasoning_effort" in body, false);
  assert.equal("apiKey" in body, false);
});

test("chat request respects profile token field and reasoning without mutating input", () => {
  const request: LlmRequest = { messages: [{ role: "user", content: "Hello" }], maxTokens: 128 };
  const before = structuredClone(request);
  const body = buildOpenAIChatBody(request, { ...profile, tokenLimitField: "max_tokens", reasoningEffort: "high" });
  assert.equal(body.max_tokens, 128);
  assert.equal("max_completion_tokens" in body, false);
  assert.equal(body.reasoning_effort, "high");
  assert.equal("tools" in body, false);
  assert.deepEqual(request, before);
});

test("chat normalizers tolerate absent content and unknown finish reasons", () => {
  assert.equal(normalizeContent(null), "");
  assert.equal(normalizeContent("answer"), "answer");
  assert.equal(normalizeContent([{ text: "a" }, null, { other: "ignored" }, { text: "b" }]), "ab");
  for (const reason of ["stop", "tool_calls", "length", "content_filter"]) assert.equal(normalizeFinishReason(reason), reason);
  assert.equal(normalizeFinishReason("future_reason"), "unknown");
});

test("invalid JSON tool arguments remain errors rather than executable empty objects", () => {
  for (const args of ["{", "[]", "null", "42"]) {
    const calls = normalizeToolCalls([{ id: "call_1", function: { name: "lookup", arguments: args } }]);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].argumentError);
    assert.equal(calls[0].id, "call_1");
  }
  assert.deepEqual(normalizeToolCalls(undefined), []);
  assert.deepEqual(normalizeToolCalls([{ id: "call_2", function: { name: "lookup", arguments: '{"q":"value"}' } }]), [{ id: "call_2", name: "lookup", input: { q: "value" } }]);
});
