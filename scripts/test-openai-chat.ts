import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { OpenAIChatAdapter, buildOpenAIChatBody, normalizeFinishReason, normalizeToolCalls } from "../src/llm/adapters/openai-chat.js";

assert.equal(normalizeFinishReason("tool_calls"), "tool_calls");
assert.equal(normalizeFinishReason("other"), "unknown");

const valid = normalizeToolCalls([{ id: "call_1", type: "function", function: { name: "demo", arguments: '{"value":1}' } }]);
assert.deepEqual(valid[0]?.input, { value: 1 });
assert.equal(valid[0]?.argumentError, undefined);
const malformed = normalizeToolCalls([{ id: "call_2", type: "function", function: { name: "demo", arguments: "{" } }]);
assert.match(malformed[0]?.argumentError ?? "", /malformed function arguments/);

const baseProfile = { name: "test", protocol: "openai_chat_completions" as const, baseUrl: "http://example.invalid/v1", apiKey: "test-key", auth: "bearer" as const, model: "test-model", reasoningEffort: "default" as const, tokenLimitField: "max_completion_tokens" as const, capabilities: { vision: true, function_tools: true, responses: false, hosted_web_search: false, hosted_image_generation: false, hosted_code_execution: false } };
const modernTokenBody = buildOpenAIChatBody({ messages: [{ role: "user", content: "hello" }], maxTokens: 123 }, baseProfile);
assert.equal(modernTokenBody.max_completion_tokens, 123);
assert.equal(modernTokenBody.max_tokens, undefined);
const legacyTokenBody = buildOpenAIChatBody({ messages: [{ role: "user", content: "hello" }], maxTokens: 456 }, { ...baseProfile, tokenLimitField: "max_tokens" });
assert.equal(legacyTokenBody.max_tokens, 456);
assert.equal(legacyTokenBody.max_completion_tokens, undefined);

let receivedBody: Record<string, unknown> | undefined;
let receivedAuth = "";
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    receivedAuth = String(request.headers.authorization ?? "");
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
        { id: "call_3", type: "function", function: { name: "demo", arguments: "{}" } },
      ] } }],
      usage: { prompt_tokens: 12, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } },
    }));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
try {
  const response = await new OpenAIChatAdapter().generate({
    messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }],
    tools: [{ name: "demo", description: "demo", parameters: { type: "object" } }],
  }, { name: "test", protocol: "openai_chat_completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "test-key", auth: "bearer", model: "test-model", reasoningEffort: "high", tokenLimitField: "max_completion_tokens", capabilities: { vision: true, function_tools: true, responses: false, hosted_web_search: false, hosted_image_generation: false, hosted_code_execution: false } });
  assert.equal(receivedAuth, "Bearer test-key");
  assert.equal(receivedBody?.model, "test-model");
  assert.equal(receivedBody?.reasoning_effort, "high");
  assert.equal(receivedBody?.max_completion_tokens, 8192);
  assert.equal(receivedBody?.max_tokens, undefined);
  assert.ok(Array.isArray(receivedBody?.tools));
  assert.equal(response.toolCalls[0]?.name, "demo");
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 3, reasoningTokens: 2 });
} finally {
  server.close();
  await once(server, "close");
}
console.log("openai chat adapter tests passed");
