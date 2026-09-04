import assert from "node:assert/strict";
import { createServer } from "node:http";
import { listGatewayModels } from "../src/llm/models.js";
import type { LlmProfile } from "../src/llm/types.js";

let requests = 0;
const server = createServer((req, res) => {
  requests++;
  assert.equal(req.method, "GET");
  assert.equal(req.url, "/v1/models");
  assert.equal(req.headers.authorization, "Bearer test-key");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: [
    { id: "z-model", object: "model" },
    { id: "a-model", object: "model" },
    { id: "a-model", object: "model" },
    { object: "model" },
  ] }));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind");
const profile: LlmProfile = {
  name: "test",
  protocol: "openai_chat_completions",
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  apiKey: "test-key",
  auth: "bearer",
  model: "fallback-model",
  reasoningEffort: "default",
  tokenLimitField: "max_completion_tokens",
  capabilities: {
    vision: true,
    function_tools: true,
    responses: false,
    hosted_web_search: false,
    hosted_image_generation: false,
    hosted_code_execution: false,
  },
};
assert.deepEqual(await listGatewayModels(profile), ["a-model", "z-model"]);
assert.deepEqual(await listGatewayModels(profile), ["a-model", "z-model"]);
assert.equal(requests, 1);
server.close();
console.log("llm model discovery tests passed");
