import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ToolActivityPicker,
  loadToolActivityPools,
  mergeToolActivityPools,
  toolActivityCategory,
} from "../src/utils/tool-activity.js";

test("tool activity lookup prefers tool, then category, then common", () => {
  assert.equal(new ToolActivityPicker({ read_file: ["tool"], read: ["category"], common: ["common"] }, () => 0).pick("read_file"), "📖 tool");
  assert.equal(new ToolActivityPicker({ read: ["category"], common: ["common"] }, () => 0).pick("read_file"), "📖 category");
  assert.equal(new ToolActivityPicker({ common: ["common"] }, () => 0).pick("unknown_tool"), "✨ common");
});

test("emoji selection can follow phrase imagery instead of only the tool category", () => {
  const magicShell = new ToolActivityPicker({ bash: ["Poking the terminal with a tiny wand..."] }, () => 0);
  assert.equal(magicShell.pick("bash"), "🪄 Poking the terminal with a tiny wand...");

  const ordinaryShell = new ToolActivityPicker({ bash: ["Running one careful command..."] }, () => 0);
  assert.equal(ordinaryShell.pick("bash"), "⚙️ Running one careful command...");
});

test("tool catalog target uses the target tool activity pool", () => {
  const picker = new ToolActivityPicker({ read_file: ["reading"], common: ["common"] }, () => 0);
  assert.equal(picker.pick("tool_catalog → read_file"), "📖 reading");
});

test("shuffle bag exhausts a pool before repeating", () => {
  const picker = new ToolActivityPicker({ common: ["a", "b", "c"] }, () => 0);
  const firstCycle = [picker.pick("x"), picker.pick("x"), picker.pick("x")];
  assert.equal(new Set(firstCycle).size, 3);
  assert.notEqual(picker.pick("x"), firstCycle[2]);
});

test("append and replace modes sanitize custom pools", () => {
  const appended = mergeToolActivityPools({ common: [" custom ", "custom", "two\nlines"] }, "append");
  assert.ok(appended.common.includes("Doing a little bit of magic..."));
  assert.deepEqual(appended.common.slice(-2), ["custom", "two lines"]);
  assert.deepEqual(mergeToolActivityPools({ common: ["custom"] }, "replace"), { common: ["custom"] });
});

test("categories cover dynamic tool families", () => {
  assert.equal(toolActivityCategory("discord_send_message"), "discord");
  assert.equal(toolActivityCategory("google_drive_read"), "google");
  assert.equal(toolActivityCategory("reminder_create"), "schedule");
  assert.equal(toolActivityCategory("soul_guardian_check"), "integrity");
  assert.equal(toolActivityCategory("skill_install"), undefined);
  assert.equal(toolActivityCategory("plugin_daily_report"), undefined);
  const picker = new ToolActivityPicker({ common: ["common"], github: ["github"] }, () => 0);
  assert.equal(picker.pick("skill_install"), "✨ common");
  assert.equal(picker.pick("plugin_daily_report"), "✨ common");
});


test("external pool files merge before inline overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "umiro-tool-activity-pools-"));
  writeFileSync(join(root, "pools.yaml"), `common:
  - from-file
read_file:
  - file-read
`);
  assert.deepEqual(loadToolActivityPools({
    file: "pools.yaml",
    inline: { read_file: ["inline-read"] },
    mode: "replace",
    root,
  }), { common: ["from-file"], read_file: ["inline-read"] });
});

test("invalid external pool files fail with a useful error", () => {
  const root = mkdtempSync(join(tmpdir(), "umiro-tool-activity-pools-"));
  writeFileSync(join(root, "pools.yaml"), `- not
- a mapping
`);
  assert.throws(() => loadToolActivityPools({ file: "pools.yaml", mode: "append", root }), /must contain a mapping/);
});
