import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { activeLlmProfile } from "../src/llm/profile.js";
import { getLlmTools, getToolDefinitions, renderToolIndex } from "../src/tools/registry.js";

const config = {
  llm: {
    active_profile: "test",
    profiles: {
      test: {
        protocol: "openai_chat_completions" as const,
        baseUrl: "https://example.invalid/v1",
        auth: "none" as const,
        apiKey: "",
        model: "test-model",
        reasoningEffort: "default" as const,
        tokenLimitField: "max_completion_tokens" as const,
        capabilities: {
          vision: false,
          function_tools: true,
          responses: false,
          hosted_web_search: false,
          hosted_image_generation: false,
          hosted_code_execution: false,
        },
      },
    },
  },
} as Parameters<typeof activeLlmProfile>[0];

const profile = activeLlmProfile(config);

test("self_evolve is absent from legacy and exposure-based tool lists", () => {
  assert.equal(getLlmTools().some(tool => tool.name === "self_evolve"), false);
  assert.equal(getToolDefinitions({
    profile,
    prompt: "Please use self_evolve to modify the source code",
    trigger: "discord-owner",
    exposureEnabled: true,
    maxMatchedTools: 50,
  }).some(tool => tool.name === "self_evolve"), false);
  assert.doesNotMatch(renderToolIndex(), /self[-_ ]development|self source-code/i);
});

test("public documentation no longer advertises self_evolve", () => {
  const publicFiles = ["README.md", "docs/DESIGN.md"];
  for (const file of publicFiles) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /self[_ -]?evolve/i, file);
  }
});
