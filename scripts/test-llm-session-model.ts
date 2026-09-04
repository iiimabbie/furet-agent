import assert from "node:assert/strict";
import test from "node:test";
import { mergeSessionState, type SessionData } from "../src/session-store.js";
import { normalizeLlmConfig } from "../src/config.js";
import { defaultSessionModelSettings, sessionLlmProfile } from "../src/llm/profile.js";

const llm = normalizeLlmConfig({
  active_profile: "gateway",
  profiles: {
    gateway: {
      protocol: "openai_chat_completions",
      baseUrl: "http://localhost:8317/v1",
      apiKey: "",
      auth: "none",
      model: "default-model",
      reasoningEffort: "default",
      tokenLimitField: "max_completion_tokens",
      capabilities: { vision: true, function_tools: true },
    },
  },
});
const config = { llm } as never;

function data(model: string, settingsRevision: number): SessionData {
  return {
    modelSettings: { profile: "gateway", model, reasoningEffort: "default", revision: settingsRevision },
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    toolHistory: [],
  };
}

test("a new session snapshots the active profile defaults", () => {
  assert.deepEqual(defaultSessionModelSettings(config), {
    profile: "gateway",
    model: "default-model",
    reasoningEffort: "default",
    revision: 0,
  });
});

test("a session profile overrides only model selection and reasoning", () => {
  const profile = sessionLlmProfile(config, {
    profile: "gateway",
    model: "session-model",
    reasoningEffort: "high",
    revision: 3,
  });
  assert.equal(profile.model, "session-model");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.baseUrl, "http://localhost:8317/v1");
});

test("an appended message preserves a concurrent session model change", () => {
  const base = data("default-model", 0);
  const desired = structuredClone(base);
  desired.messages.push({ role: "user", content: "hello" });
  const current = data("other-model", 1);
  const merged = mergeSessionState(base, desired, current);
  assert.equal(merged.modelSettings.model, "other-model");
  assert.equal(merged.messages.length, 1);
});

test("same-revision concurrent model changes conflict instead of silently winning", () => {
  const base = data("default-model", 0);
  const desired = data("model-a", 1);
  const current = data("model-b", 1);
  assert.throws(
    () => mergeSessionState(base, desired, current),
    /concurrent session conflict while changing model settings/,
  );
});
