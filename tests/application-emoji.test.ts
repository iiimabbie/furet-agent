/**
 * Unit tests for the Application Emoji core (`src/emoji.ts`):
 *   - resolveEmojiMarkup: :name: → <:name:id> / <a:name:id>, unknown names left as-is,
 *     code fences and inline code spans never touched, empty cache is a no-op.
 *   - buildEmojiPromptSection: empty when no emojis; lists names + syntax otherwise.
 *
 * The cache is injected directly with __setEmojiCacheForTest so no Discord API is hit.
 *
 * Run: npx tsx tests/application-emoji.test.ts
 */

import {
  resolveEmojiMarkup,
  buildEmojiPromptSection,
  getEmojiCatalog,
  __setEmojiCacheForTest,
  __clearEmojiCacheForTest,
} from "../src/emoji.js";

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

function eq(actual: string, expected: string, label: string) {
  assert(actual === expected, label, actual === expected ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function main() {
  console.log("\n🧪 Application Emoji core tests\n");

  console.log("Empty cache (never synced) is a safe no-op:");
  __clearEmojiCacheForTest();
  eq(resolveEmojiMarkup("hi :wave: there"), "hi :wave: there", "no cache → text unchanged");
  eq(buildEmojiPromptSection(), "", "no cache → empty prompt section");
  assert(getEmojiCatalog().length === 0, "no cache → empty catalog");

  console.log("\nWith a cache injected:");
  __setEmojiCacheForTest([
    { name: "umiro", id: "111", animated: false },
    { name: "wiggle", id: "222", animated: true },
  ]);

  console.log("\nResolution of known names:");
  eq(resolveEmojiMarkup("hello :umiro:"), "hello <:umiro:111>", "static emoji → <:name:id>");
  eq(resolveEmojiMarkup(":wiggle: dance"), "<a:wiggle:222> dance", "animated emoji → <a:name:id>");
  eq(resolveEmojiMarkup(":umiro: and :wiggle:"), "<:umiro:111> and <a:wiggle:222>", "multiple in one line");

  console.log("\nUnknown names are never fabricated:");
  eq(resolveEmojiMarkup("nope :unknown:"), "nope :unknown:", "unknown name left as plain text");
  eq(resolveEmojiMarkup(":umiro: :unknown:"), "<:umiro:111> :unknown:", "known replaced, unknown kept");

  console.log("\nCode fences are not touched:");
  eq(
    resolveEmojiMarkup("before :umiro:\n```\nexample :umiro: inside\n```\nafter :wiggle:"),
    "before <:umiro:111>\n```\nexample :umiro: inside\n```\nafter <a:wiggle:222>",
    "fenced block content preserved, surrounding text replaced",
  );
  eq(
    resolveEmojiMarkup("```ts\nconst x = ':umiro:';\n```"),
    "```ts\nconst x = ':umiro:';\n```",
    "language-tagged fence preserved",
  );
  eq(
    resolveEmojiMarkup("~~~\n:umiro:\n~~~"),
    "~~~\n:umiro:\n~~~",
    "tilde fence preserved",
  );

  console.log("\nInline code spans are not touched:");
  eq(resolveEmojiMarkup("use `:umiro:` like this"), "use `:umiro:` like this", "single-backtick span preserved");
  eq(resolveEmojiMarkup("text :umiro: then `code :wiggle:` end"), "text <:umiro:111> then `code :wiggle:` end", "replace outside span, keep inside");
  eq(resolveEmojiMarkup("``:umiro:`` double ticks"), "``:umiro:`` double ticks", "double-backtick span preserved");

  console.log("\nName validation:");
  eq(resolveEmojiMarkup(":a:"), ":a:", "single-char name below 2-char minimum is ignored");
  eq(resolveEmojiMarkup("time 12:34:56 here"), "time 12:34:56 here", "colon-delimited digits are not names (contains digits only run but no cache match)");
  eq(resolveEmojiMarkup("ratio 3:umiro:1"), "ratio 3<:umiro:111>1", "matches valid name even when adjacent to other chars");

  console.log("\nPrompt section lists names + syntax:");
  const section = buildEmojiPromptSection();
  assert(section.includes("<application-emojis>"), "section has tag");
  assert(section.includes(":umiro:") && section.includes(":wiggle:"), "section lists both names in :name: form");
  assert(!section.includes("111") && !section.includes("222"), "section does NOT leak raw emoji IDs (token control + no hardcoded IDs)");

  __clearEmojiCacheForTest();

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
