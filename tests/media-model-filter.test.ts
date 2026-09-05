/**
 * Unit tests for the conversation-model filter (`src/llm/models.ts`).
 *
 * A gateway lists every model it can route, including image and video generators that
 * only answer on their own endpoints. Picking one of those in `/model` breaks the
 * session with a 400 or 503, so they are hidden from the picker — but NOT from
 * `listGatewayModels`, because plugins that call those endpoints need to see them.
 *
 * The match is per ID segment, not a substring: `grok-imagine-image` is excluded by its
 * `image` segment, while a bare `grok-imagine-*` would not be, and no ordinary model ID
 * is caught by accident.
 *
 * Run: npx tsx --test tests/media-model-filter.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isMediaModel } from "../src/llm/models.js";

test("excludes image and video generators", () => {
  for (const id of [
    "gpt-image-2",
    "gpt-image-1.5",
    "grok-imagine-image",
    "grok-imagine-image-2.0",
    "grok-imagine-image-quality",
    "grok-imagine-video",
    "grok-imagine-video-1.5",
    "grok-imagine-video-1.5-preview",
  ]) {
    assert.equal(isMediaModel(id), true, `${id} should be filtered out`);
  }
});

test("keeps conversation models", () => {
  for (const id of [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "grok-4.6",
    "kimi-k3",
    "deepseek-v4-pro:0813",
    "glm-5.3-flash",
    "gpt-oss:120b",
    "qwen3.5:397b",
    "nemotron-3-ultra",
    "mistral-large-3:675b",
  ]) {
    assert.equal(isMediaModel(id), false, `${id} should stay in the picker`);
  }
});

test("matches whole segments, not substrings", () => {
  // `imagine` contains neither `image` nor `img` as a segment.
  assert.equal(isMediaModel("grok-imagine"), false);
  // `vision` is not `video`; a vision-capable chat model must stay selectable.
  assert.equal(isMediaModel("some-vision-model"), false);
  // Segment separators vary across gateways.
  assert.equal(isMediaModel("provider/image/v2"), true);
  assert.equal(isMediaModel("img-gen-3"), true);
  assert.equal(isMediaModel("IMAGE-2"), true);
});
