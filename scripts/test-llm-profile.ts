import assert from "node:assert/strict";
import { normalizeLlmConfig } from "../src/config.js";
import { activeLlmProfile } from "../src/llm/profile.js";

const configured = normalizeLlmConfig({
  active_profile: "ollama",
  profiles: {
    ollama: {
      protocol: "openai_chat_completions",
      baseUrl: "http://localhost:11434/v1/",
      auth: "none",
      model: "qwen3:8b",
      tokenLimitField: "max_tokens",
      capabilities: { function_tools: true },
    },
  },
});
const profile = activeLlmProfile({ llm: configured } as never);
assert.equal(profile.name, "ollama");
assert.equal(profile.baseUrl, "http://localhost:11434/v1");
assert.equal(profile.auth, "none");
assert.equal(profile.tokenLimitField, "max_tokens");
assert.equal(profile.capabilities.function_tools, true);
assert.equal(profile.capabilities.hosted_web_search, false);

assert.throws(
  () => normalizeLlmConfig({
    base_url: "http://localhost:8317/v1",
    api_key: "old-key",
    currentModel: "old-model",
  }),
  /llm\.profiles must define at least one valid connection profile/,
);

console.log("llm profile tests passed");
