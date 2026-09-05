/**
 * Unit tests for authoritativeNowBlock — the authoritative local-datetime block
 * prepended to cron / reminder user prompts so the model cannot mis-judge "today"
 * as the previous day when upstream context carries a stale date.
 * Run: npx tsx tests/authoritative-now.test.ts
 */

import { authoritativeNowBlock } from "../src/prompt.js";
import { nowWithZone } from "../src/utils/time.js";

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
  console.log("\n🧪 authoritativeNowBlock tests\n");

  const fixed = "2026-08-24 10:10:43 (Asia/Taipei)";
  const block = authoritativeNowBlock(fixed);

  console.log("Content with injected datetime:");
  assert(block.includes(fixed), "embeds the exact datetime string passed in", block.slice(0, 120));
  assert(
    block.includes("AUTHORITATIVE CURRENT LOCAL DATETIME"),
    "marks the datetime as authoritative",
  );
  assert(
    /single source of truth/i.test(block),
    "states it is the single source of truth for today/now",
  );
  assert(
    /ignore and override|override any other date/i.test(block),
    "instructs to ignore/override conflicting upstream dates",
  );
  assert(
    /do NOT treat today'?s data as belonging to the future|not.*future/i.test(block),
    "instructs not to treat today's tool data as the future",
  );

  console.log("\nStructure:");
  assert(block.startsWith("[System]"), "is a [System] block");
  assert(block.endsWith("\n\n"), "ends with a blank-line separator so the task prompt follows cleanly");

  console.log("\nDefault argument:");
  const live = authoritativeNowBlock();
  const liveNow = nowWithZone();
  // Both computed within the same second in almost all cases; compare the date+hour prefix
  // to avoid a flaky failure if the clock ticks a second between the two calls.
  const prefix = liveNow.slice(0, 16); // "YYYY-MM-DD HH:mm"
  assert(
    live.includes(prefix),
    "defaults to nowWithZone() when no argument is given",
    `expected block to contain "${prefix}"`,
  );
  assert(
    live.includes(nowWithZone().slice(20)) || /\([A-Za-z_]+\/[A-Za-z_]+\)|\(UTC\)/.test(live),
    "includes the timezone name from nowWithZone()",
  );

  console.log("\nDeterminism:");
  assert(
    authoritativeNowBlock(fixed) === authoritativeNowBlock(fixed),
    "same input produces identical output (pure function)",
  );

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
