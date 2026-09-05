import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function loadFromYaml(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), "umiro-tool-activity-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml);
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", 'import { loadConfig } from "./src/config.ts"; console.log(JSON.stringify(loadConfig().discord.tool_activity));'],
    { cwd: process.cwd(), env: { ...process.env, UMIRO_CONFIG_PATH: path }, encoding: "utf8" },
  );
  return JSON.parse(stdout.trim());
}

test("tool activity config defaults are safe and enabled", () => {
  assert.deepEqual(loadFromYaml("{}"), {
    enabled: true,
    mode: "append",
    pools_file: "",
    pools: {},
  });
});

test("tool activity config normalizes mode and string-list pools", () => {
  assert.deepEqual(loadFromYaml(`discord:
  tool_activity:
    enabled: false
    mode: replace
    pools_file: workspace/config/tool-activity.yaml
    pools:
      read_file: ["one", 2, "two"]
      invalid: nope
`), {
    enabled: false,
    mode: "replace",
    pools_file: "workspace/config/tool-activity.yaml",
    pools: { read_file: ["one", "two"] },
  });
});
