import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync,
  existsSync, appendFileSync, openSync, readSync, closeSync, fstatSync,
  globSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { loadConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { WORKSPACE_DIR } from "../../paths.js";
import type { Tool } from "../../types.js";

// ── Paths ──

const STATE_DIR = resolve(WORKSPACE_DIR, "memory", "soul-guardian");
const BASELINES_PATH = resolve(STATE_DIR, "baselines.json");
const AUDIT_PATH = resolve(STATE_DIR, "audit.jsonl");
const APPROVED_DIR = resolve(STATE_DIR, "approved");
const PATCH_DIR = resolve(STATE_DIR, "patches");
const QUARANTINE_DIR = resolve(STATE_DIR, "quarantine");

const CHAIN_GENESIS = "0".repeat(64);

// ── Helpers ──

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function refuseSymlink(p: string): void {
  if (isSymlink(p)) throw new Error(`Refusing to operate on symlink: ${p}`);
}

function atomicWrite(p: string, data: Buffer): void {
  ensureDir(dirname(p));
  const tmp = p + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, p);
}

function safePatchTag(tag: string): string {
  return (tag.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)) || "patch";
}

function tsTag(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// ── Policy & Baselines ──

interface Target { path: string; mode: "restore" | "alert" | "ignore"; }
interface BaselineEntry { sha256: string; approvedAt: string; }
interface Baselines { version: number; files: Record<string, BaselineEntry>; }

function loadTargets(): Target[] {
  return loadConfig().soul_guardian.targets;
}

function reconstructFromSnapshots(): Baselines {
  const baselines: Baselines = { version: 1, files: {} };
  try {
    const targets = loadTargets();
    for (const t of targets) {
      if (t.mode === "ignore") continue;
      const snap = approvedSnapshotPath(t.path);
      if (!existsSync(snap) || isSymlink(snap)) continue;
      const content = readFileSync(snap);
      baselines.files[t.path] = { sha256: sha256(content), approvedAt: "reconstructed" };
    }
  } catch { /* config not ready yet, return empty */ }
  if (Object.keys(baselines.files).length > 0) {
    logger.warn({ count: Object.keys(baselines.files).length }, "baselines reconstructed from approved snapshots");
    saveBaselines(baselines);
  }
  return baselines;
}

function loadBaselines(): Baselines {
  if (!existsSync(BASELINES_PATH)) return reconstructFromSnapshots();
  const baselines: Baselines = JSON.parse(readFileSync(BASELINES_PATH, "utf-8"));
  if (Object.keys(baselines.files).length === 0) return reconstructFromSnapshots();
  return baselines;
}

function saveBaselines(b: Baselines): void {
  ensureDir(STATE_DIR);
  atomicWrite(BASELINES_PATH, Buffer.from(JSON.stringify(b, null, 2) + "\n"));
}

function resolveTargets(): Target[] {
  const dedup = new Map<string, Target["mode"]>();
  for (const t of loadTargets()) {
    const mode = t.mode;
    if (!["restore", "alert", "ignore"].includes(mode)) continue;

    if (t.path.includes("*")) {
      // glob pattern
      const matches = globSync(t.path, { cwd: WORKSPACE_DIR }).filter(m => {
        try { return !lstatSync(resolve(WORKSPACE_DIR, m)).isDirectory(); } catch { return false; }
      });
      for (const m of matches) dedup.set(m, mode);
    } else {
      dedup.set(t.path, mode);
    }
  }
  return [...dedup.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, mode]) => ({ path, mode }));
}

// ── Audit log (hash chaining) ──

function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function lastAuditHash(): string {
  if (!existsSync(AUDIT_PATH)) return CHAIN_GENESIS;
  const fd = openSync(AUDIT_PATH, "r");
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return CHAIN_GENESIS;
    const blockSize = Math.min(65536, size);
    const buf = Buffer.alloc(blockSize);
    readSync(fd, buf, 0, blockSize, size - blockSize);
    const lines = buf.toString("utf-8").split("\n").filter(l => l.trim());
    if (!lines.length) return CHAIN_GENESIS;
    const last = JSON.parse(lines[lines.length - 1]);
    return last?.chain?.hash ?? CHAIN_GENESIS;
  } catch { return CHAIN_GENESIS; }
  finally { closeSync(fd); }
}

function appendAudit(entry: Record<string, unknown>): void {
  ensureDir(STATE_DIR);
  const prev = lastAuditHash();
  const entryNoChain = { ...entry };
  delete entryNoChain.chain;
  const payload = prev + "\n" + canonicalJson(entryNoChain);
  const hash = createHash("sha256").update(payload, "utf-8").digest("hex");
  const record = { ...entryNoChain, chain: { prev, hash } };
  appendFileSync(AUDIT_PATH, JSON.stringify(record) + "\n");
}

// ── Diff / Patch ──

function writePatch(patchText: string, tag: string, relp: string): string {
  ensureDir(PATCH_DIR);
  const fileTag = safePatchTag(relp.replace(/\//g, "_"));
  const path = resolve(PATCH_DIR, `${tsTag()}-${fileTag}-${safePatchTag(tag)}.patch`);
  atomicWrite(path, Buffer.from(patchText));
  return path;
}

function unifiedDiff(oldText: string, newText: string, fromFile: string, toFile: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lines: string[] = [`--- ${fromFile}`, `+++ ${toFile}`];

  // Simple full-file diff (good enough for audit patches)
  lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
  for (const l of oldLines) lines.push(`-${l}`);
  for (const l of newLines) lines.push(`+${l}`);

  return lines.join("\n") + "\n";
}

// ── Core operations ──

function approvedSnapshotPath(relp: string): string {
  return resolve(APPROVED_DIR, relp);
}

function fileStatus(relp: string, baselines: Baselines) {
  const abs = resolve(WORKSPACE_DIR, relp);
  const baseline = baselines.files[relp];
  const approvedSha = baseline?.sha256 ?? null;
  const snap = approvedSnapshotPath(relp);

  let currentSha: string | null = null;
  if (existsSync(abs) && !isSymlink(abs)) {
    try { currentSha = sha256(readFileSync(abs)); } catch { /* */ }
  }

  return {
    exists: existsSync(abs),
    isSymlink: existsSync(abs) ? isSymlink(abs) : false,
    approvedSha,
    currentSha,
    approvedSnapshot: existsSync(snap) ? snap : null,
    ok: approvedSha !== null && currentSha === approvedSha,
  };
}

function detectDrift(relp: string, baselines: Baselines): { drifted: boolean; info: Record<string, unknown> } {
  const abs = resolve(WORKSPACE_DIR, relp);
  if (!existsSync(abs)) return { drifted: true, info: { error: `Missing ${relp}` } };
  refuseSymlink(abs);

  const baseline = baselines.files[relp];
  if (!baseline) return { drifted: true, info: { error: `No baseline for ${relp}. Run approve first.` } };

  const snap = approvedSnapshotPath(relp);
  if (!existsSync(snap)) return { drifted: true, info: { error: `Missing approved snapshot for ${relp}.` } };

  const curBytes = readFileSync(abs);
  const curSha = sha256(curBytes);
  if (curSha === baseline.sha256) return { drifted: false, info: { approvedSha: baseline.sha256, currentSha: curSha } };

  const oldText = readFileSync(snap, "utf-8");
  const newText = readFileSync(abs, "utf-8");
  const patchText = unifiedDiff(oldText, newText, `approved/${relp}`, relp);
  const patchPath = writePatch(patchText, "drift", relp);

  return { drifted: true, info: { approvedSha: baseline.sha256, currentSha: curSha, patchPath } };
}

function restoreOne(relp: string, info: Record<string, unknown>): Record<string, unknown> {
  const abs = resolve(WORKSPACE_DIR, relp);
  refuseSymlink(abs);
  const snap = approvedSnapshotPath(relp);
  if (!existsSync(snap)) throw new Error(`Missing approved snapshot for ${relp}`);

  ensureDir(QUARANTINE_DIR);
  const fileTag = safePatchTag(relp.replace(/\//g, "_"));
  const quarantinePath = resolve(QUARANTINE_DIR, `${fileTag}.${tsTag()}.quarantine`);
  atomicWrite(quarantinePath, readFileSync(abs));
  atomicWrite(abs, readFileSync(snap));

  return { quarantinePath, ...info };
}

// ── Tool: status ──

export const soulGuardianStatus: Tool = {
  name: "soul_guardian_status",
  description: "Show soul-guardian protection status: list all monitored files, current hash, and drift state.",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    logger.info("soul_guardian status");
    try {
      const baselines = loadBaselines();
      const targets = resolveTargets();

      const files = targets.map(t => {
        const s = fileStatus(t.path, baselines);
        return { path: t.path, mode: t.mode, ...s };
      });

      return JSON.stringify({ workspace: WORKSPACE_DIR, stateDir: STATE_DIR, files }, null, 2);
    } catch (e) { return `Error: ${(e as Error).message}`; }
  },
};

// ── Tool: check ──

export const soulGuardianCheck: Tool = {
  name: "soul_guardian_check",
  description: "Run soul-guardian integrity check. Detect drift from baselines; restore-mode files are auto-restored by default.",
  parameters: {
    type: "object",
    properties: {
      no_restore: { type: "boolean", description: "Set to true to check only without restoring (default false)" },
    },
  },
  execute: async (args) => {
    const { no_restore } = args as { no_restore?: boolean };
    logger.info({ no_restore }, "soul_guardian check");
    try {
      const baselines = loadBaselines();
      const targets = resolveTargets();
      const drifted: Record<string, unknown>[] = [];

      for (const t of targets) {
        if (t.mode === "ignore") continue;
        const { drifted: isDrift, info } = detectDrift(t.path, baselines);
        if (!isDrift) continue;

        if ("error" in info) {
          appendAudit({ ts: utcNowIso(), event: "error", actor: "furet", path: t.path, mode: t.mode, error: info.error });
          drifted.push({ path: t.path, mode: t.mode, error: info.error });
          continue;
        }

        appendAudit({ ts: utcNowIso(), event: "drift", actor: "furet", path: t.path, mode: t.mode, ...info });
        const rec: Record<string, unknown> = { path: t.path, mode: t.mode, ...info };

        if (t.mode === "restore" && !no_restore) {
          const restored = restoreOne(t.path, info);
          appendAudit({ ts: utcNowIso(), event: "restore", actor: "furet", path: t.path, mode: t.mode, ...restored });
          rec.restored = true;
          rec.quarantinePath = restored.quarantinePath;
        } else {
          rec.restored = false;
        }
        drifted.push(rec);
      }

      if (!drifted.length) return "OK: all monitored files match their baselines.";

      const lines = ["DRIFT DETECTED", ""];
      for (const d of drifted) {
        lines.push(`${d.path} (${d.mode})`);
        if (d.error) { lines.push(`  error: ${d.error}`); }
        else if (d.restored) { lines.push("  -> auto-restored to baseline"); }
        else { lines.push("  -> drift detected (not restored)"); }
        lines.push("");
      }
      return lines.join("\n");
    } catch (e) { return `Error: ${(e as Error).message}`; }
  },
};

// ── Tool: approve ──

export const soulGuardianApprove: Tool = {
  name: "soul_guardian_approve",
  description: "Approve the current version of a file as the new baseline. Must verify file content is correct before approving.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "File path to approve (relative to workspace)" },
      all: { type: "boolean", description: "Approve all monitored files (mutually exclusive with file)" },
      note: { type: "string", description: "Reason for this approval" },
    },
    required: ["note"],
  },
  execute: async (args) => {
    const { file, all, note } = args as { file?: string; all?: boolean; note: string };
    if (!file && !all) return "Error: must specify file or all";
    if (file && all) return "Error: file and all are mutually exclusive";
    logger.info({ file, all, note }, "soul_guardian approve");

    try {
      const baselines = loadBaselines();
      const targets = resolveTargets().filter(t => t.mode !== "ignore");

      let chosen: Target[];
      if (all) {
        chosen = targets;
      } else {
        chosen = targets.filter(t => t.path === file);
        if (!chosen.length) return `Error: ${file} not found in policy or is ignored`;
      }

      const results: string[] = [];
      for (const t of chosen) {
        const abs = resolve(WORKSPACE_DIR, t.path);
        if (!existsSync(abs)) { results.push(`Skipped ${t.path}: file not found`); continue; }
        refuseSymlink(abs);

        const prevSha = baselines.files[t.path]?.sha256 ?? null;
        const prevText = existsSync(approvedSnapshotPath(t.path))
          ? readFileSync(approvedSnapshotPath(t.path), "utf-8") : "";

        const curBytes = readFileSync(abs);
        const curSha = sha256(curBytes);
        const curText = readFileSync(abs, "utf-8");

        const patchText = unifiedDiff(prevText, curText, `approved/${t.path}`, t.path);
        const patchPath = writePatch(patchText, "approve", t.path);

        const snap = approvedSnapshotPath(t.path);
        ensureDir(dirname(snap));
        atomicWrite(snap, curBytes);

        baselines.files[t.path] = { sha256: curSha, approvedAt: utcNowIso() };

        appendAudit({
          ts: utcNowIso(), event: "approve", actor: "furet", note,
          path: t.path, mode: t.mode, prevApprovedSha: prevSha, approvedSha: curSha, patchPath,
        });

        results.push(`✅ ${t.path}: sha256=${curSha.slice(0, 16)}...`);
      }

      saveBaselines(baselines);
      return results.join("\n");
    } catch (e) { return `Error: ${(e as Error).message}`; }
  },
};

// ── Tool: restore ──

export const soulGuardianRestore: Tool = {
  name: "soul_guardian_restore",
  description: "Manually restore a file to the last approved baseline version.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "File path to restore (relative to workspace)" },
      all: { type: "boolean", description: "Restore all restore-mode files (mutually exclusive with file)" },
      note: { type: "string", description: "Reason for this restore" },
    },
    required: ["note"],
  },
  execute: async (args) => {
    const { file, all, note } = args as { file?: string; all?: boolean; note: string };
    if (!file && !all) return "Error: must specify file or all";
    if (file && all) return "Error: file and all are mutually exclusive";
    logger.info({ file, all, note }, "soul_guardian restore");

    try {
      const baselines = loadBaselines();
      const targets = resolveTargets().filter(t => t.mode === "restore");

      let chosen: Target[];
      if (all) {
        chosen = targets;
      } else {
        chosen = targets.filter(t => t.path === file);
        if (!chosen.length) return `Error: ${file} is not in restore mode or not in policy`;
      }

      const results: string[] = [];
      for (const t of chosen) {
        const { drifted: isDrift, info } = detectDrift(t.path, baselines);
        if ("error" in info) { results.push(`${t.path}: ${info.error}`); continue; }
        if (!isDrift) { results.push(`${t.path}: no drift, nothing to restore`); continue; }

        const restored = restoreOne(t.path, info);
        appendAudit({
          ts: utcNowIso(), event: "restore", actor: "furet", note,
          path: t.path, mode: t.mode, ...restored,
        });
        results.push(`${t.path}: restored`);
      }

      return results.join("\n") || "No files needed restoring.";
    } catch (e) { return `Error: ${(e as Error).message}`; }
  },
};
