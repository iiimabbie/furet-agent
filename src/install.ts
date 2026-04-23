import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname!, "..");
const WORKSPACE = resolve(ROOT, "workspace");
const TEMPLATES = resolve(ROOT, "templates");

function run(cmd: string, opts?: { sudo?: boolean }) {
  const full = opts?.sudo ? `sudo ${cmd}` : cmd;
  console.log(`$ ${full}`);
  execSync(full, { stdio: "inherit", cwd: ROOT });
}

function copyIfMissing(src: string, dest: string) {
  if (existsSync(dest)) {
    console.log(`skip: ${dest} already exists`);
  } else {
    copyFileSync(src, dest);
    console.log(`created: ${dest}`);
  }
}

function ensureDir(path: string) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    console.log(`created: ${path}`);
  }
}

// --- 1. npm install ---
console.log("\n=== Installing dependencies ===");
run("npm install");

// --- 2. config files ---
console.log("\n=== Config files ===");
copyIfMissing(resolve(ROOT, "config.example.yaml"), resolve(ROOT, "config.yaml"));
copyIfMissing(resolve(ROOT, ".env.example"), resolve(ROOT, ".env"));

// --- 3. workspace ---
console.log("\n=== Setting up workspace ===");
ensureDir(WORKSPACE);
ensureDir(resolve(WORKSPACE, "config"));
ensureDir(resolve(WORKSPACE, "memory"));
ensureDir(resolve(WORKSPACE, "sessions"));
ensureDir(resolve(WORKSPACE, "sessions/archive"));
ensureDir(resolve(WORKSPACE, "skills"));
ensureDir(resolve(WORKSPACE, "memory", "soul-guardian"));

// workspace files from templates
copyIfMissing(resolve(TEMPLATES, "AGENT.md"), resolve(WORKSPACE, "AGENT.md"));
copyIfMissing(resolve(TEMPLATES, "SOUL.md"), resolve(WORKSPACE, "SOUL.md"));
copyIfMissing(resolve(TEMPLATES, "MEMORY.md"), resolve(WORKSPACE, "MEMORY.md"));
copyIfMissing(resolve(TEMPLATES, "PEOPLE.md"), resolve(WORKSPACE, "PEOPLE.md"));
copyIfMissing(resolve(TEMPLATES, "JOURNAL.md"), resolve(WORKSPACE, "JOURNAL.md"));

// empty json files
for (const name of ["crons.json", "reminders.json"]) {
  const path = resolve(WORKSPACE, "config", name);
  if (!existsSync(path)) {
    writeFileSync(path, "[]");
    console.log(`created: ${path}`);
  }
}

// --- 3b. soul-guardian initial baselines ---
const sgStateDir = resolve(WORKSPACE, "memory", "soul-guardian");
const sgBaselinesPath = resolve(sgStateDir, "baselines.json");
const sgApprovedDir = resolve(sgStateDir, "approved");

if (!existsSync(sgBaselinesPath)) {
  console.log("\n=== Initializing soul-guardian baselines ===");
  try {
    const configRaw = parse(readFileSync(resolve(ROOT, "config.yaml"), "utf-8")) as Record<string, unknown>;
    const sg = configRaw.soul_guardian as { targets?: { path: string; mode: string }[] } | undefined;
    const targets = sg?.targets ?? [];
    const files: Record<string, { sha256: string; approvedAt: string }> = {};

    for (const t of targets) {
      if (t.mode === "ignore") continue;
      const abs = resolve(WORKSPACE, t.path);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs);
      const hash = createHash("sha256").update(content).digest("hex");
      files[t.path] = { sha256: hash, approvedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00") };
      // snapshot
      const snapDir = dirname(resolve(sgApprovedDir, t.path));
      ensureDir(snapDir);
      copyFileSync(abs, resolve(sgApprovedDir, t.path));
      console.log(`baseline: ${t.path} (${hash.slice(0, 16)}...)`);
    }

    writeFileSync(sgBaselinesPath, JSON.stringify({ version: 1, files }, null, 2) + "\n");
  } catch (e) {
    console.log(`soul-guardian init skipped: ${(e as Error).message}`);
  }
}

// --- 4. npm link ---
console.log("\n=== Registering furet command ===");
run("npm link");

// --- 5. systemd service ---
console.log("\n=== Installing systemd service ===");

const nodeBinDir = dirname(process.execPath);
const furetBin = `${nodeBinDir}/furet`;

const unit = `[Unit]
Description=Furet Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${process.env.USER}
WorkingDirectory=${ROOT}
ExecStart=${furetBin} gateway
Restart=on-failure
RestartSec=5
Environment=PATH=${nodeBinDir}:${ROOT}/node_modules/.bin:/usr/bin

[Install]
WantedBy=multi-user.target
`;

const tmp = "/tmp/furet.service";
writeFileSync(tmp, unit);
run(`cp ${tmp} /etc/systemd/system/furet.service`, { sudo: true });
unlinkSync(tmp);

run("systemctl daemon-reload", { sudo: true });
run("systemctl enable furet", { sudo: true });

console.log("\n=== Done ===");
console.log("Edit .env and config.yaml, then run: furet gateway");
