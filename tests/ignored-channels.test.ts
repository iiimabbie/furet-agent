/**
 * Unit tests for the Discord ignored-channel gate (`src/utils/ignored-channels.ts`).
 *
 * `isIgnoredChannel` returns true only for an EXACT channel/thread ID listed in
 * `discord.ignored_channels`. The gate is consumed at the very top of the
 * MessageCreate handler in `src/bot.ts`, before trigger evaluation / session
 * creation, so a listed thread is fully silenced regardless of mention, reply,
 * DM, or ambient membership. No private IDs are hardcoded here.
 *
 * Run: npx tsx tests/ignored-channels.test.ts
 */

import { isIgnoredChannel } from "../src/utils/ignored-channels.js";
import type { UmiroConfig } from "../src/config.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function makeConfig(ignored: string[]): UmiroConfig {
  return { discord: { ignored_channels: ignored } } as unknown as UmiroConfig;
}

function main() {
  console.log("isIgnoredChannel:");

  const cfg = makeConfig(["111", "222"]);
  assert(isIgnoredChannel("111", cfg), "exact match (first)");
  assert(isIgnoredChannel("222", cfg), "exact match (second)");
  assert(!isIgnoredChannel("333", cfg), "unlisted channel is not ignored");
  assert(!isIgnoredChannel("11", cfg), "prefix is not a match");
  assert(!isIgnoredChannel("1111", cfg), "superstring is not a match");

  const empty = makeConfig([]);
  assert(!isIgnoredChannel("111", empty), "empty list ignores nothing");

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
