/**
 * Unit tests for the shared silent-reply gate (`src/utils/no-reply.ts`), plus the
 * two call boundaries that consume it:
 *   - `src/bot.ts` re-exports `isNoReplySentinel` (ordinary Discord replies)
 *   - `src/gateway.ts` imports it for cron / reminder `[no_reply]` handling
 *
 * Canonical token is `[no_reply]`. The match is whole-string equality (trimmed,
 * case-insensitive), NOT `includes`, so an ordinary reply that merely contains
 * the token somewhere is not swallowed. The legacy `[noreply]` alias is still
 * accepted for backward compatibility, but only the canonical token is promoted
 * in prompts and docs.
 *
 * Run: npx tsx tests/no-reply-sentinel.test.ts
 */

import { isNoReplySentinel, NO_REPLY_TOKEN } from "../src/utils/no-reply.js";
import { isNoReplySentinel as isNoReplySentinelFromBot } from "../src/bot.js";

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

function main() {
  console.log("\n🧪 isNoReplySentinel tests\n");

  console.log("Canonical token:");
  assert(NO_REPLY_TOKEN === "[no_reply]", "NO_REPLY_TOKEN is the canonical [no_reply]");

  console.log("\nShared helper is the single source (bot.ts re-exports it):");
  assert(isNoReplySentinelFromBot === isNoReplySentinel, "bot.ts exports the same function instance");

  console.log("\nSuppresses (returns true):");
  assert(isNoReplySentinel("[no_reply]"), "exact sentinel");
  assert(isNoReplySentinel("  [no_reply]  "), "leading/trailing spaces");
  assert(isNoReplySentinel("\n[no_reply]\n"), "surrounding newlines");
  assert(isNoReplySentinel("\t [no_reply] \t"), "surrounding tabs + spaces");
  assert(isNoReplySentinel("[NO_REPLY]"), "uppercase");
  assert(isNoReplySentinel("[No_Reply]"), "mixed case");
  assert(isNoReplySentinel("[no_REPLY]  "), "mixed case + trailing space");

  console.log("\nLegacy alias (backward compat with the old cron token):");
  assert(isNoReplySentinel("[noreply]"), "legacy [noreply] (no underscore) still accepted");
  assert(isNoReplySentinel("  [NOREPLY]  "), "legacy alias, trimmed + uppercased");

  console.log("\nDoes NOT suppress (returns false):");
  assert(!isNoReplySentinel("好的，我知道了"), "ordinary reply");
  assert(!isNoReplySentinel("我先不回覆好了 [no_reply]"), "sentinel embedded after real text (would be eaten by includes)");
  assert(!isNoReplySentinel("[no_reply] 但其實還有話說"), "sentinel embedded before real text");
  assert(!isNoReplySentinel("這是 [no_reply] 的說明文件"), "sentinel embedded mid-sentence");
  assert(!isNoReplySentinel("排程正常 [noreply] 附註"), "legacy alias embedded with real text is not swallowed");
  assert(!isNoReplySentinel("no_reply"), "missing brackets");
  assert(!isNoReplySentinel("[[no_reply]]"), "doubled brackets");
  assert(!isNoReplySentinel("`[no_reply]`"), "wrapped in code ticks");

  console.log("\nEdge cases (empty-ish input → false; handled by the earlier !response.text branch):");
  assert(!isNoReplySentinel(""), "empty string");
  assert(!isNoReplySentinel("   "), "whitespace only");
  assert(!isNoReplySentinel(undefined), "undefined");
  assert(!isNoReplySentinel(null), "null");

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
