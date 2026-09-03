import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync,
  existsSync, appendFileSync, openSync, readSync, closeSync, fstatSync,
  globSync, readdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { loadConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { WORKSPACE_DIR } from "../../paths.js";
import { getTrigger } from "../context.js";
import { isOwnerIdentity } from "../authz.js";
import type { Tool } from "../../types.js";

// ── Paths ──

const STATE_DIR = resolve(WORKSPACE_DIR, "memory", "soul-guardian");
const BASELINES_PATH = resolve(STATE_DIR, "baselines.json");
const AUDIT_PATH = resolve(STATE_DIR, "audit.jsonl");
const APPROVED_DIR = resolve(STATE_DIR, "approved");
const PATCH_DIR = resolve(STATE_DIR, "patches");
const QUARANTINE_DIR = resolve(STATE_DIR, "quarantine");
const HISTORY_DIR = resolve(STATE_DIR, "history");

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

/** Archive current approved snapshot to history/ before overwriting */
function archiveSnapshot(relp: string): string | null {
  const snap = approvedSnapshotPath(relp);
  if (!existsSync(snap) || isSymlink(snap)) return null;
  ensureDir(HISTORY_DIR);
  const fileTag = safePatchTag(relp.replace(/\//g, "_"));
  const histPath = resolve(HISTORY_DIR, `${fileTag}.${tsTag()}`);
  atomicWrite(histPath, readFileSync(snap));
  return histPath;
}

/** List history versions for a file, newest first */
function listHistory(relp: string): { path: string; timestamp: string }[] {
  const fileTag = safePatchTag(relp.replace(/\//g, "_"));
  const prefix = fileTag + ".";
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR)
    .filter(f => f.startsWith(prefix) && !f.endsWith(".tmp"))
    .sort().reverse()
    .map(f => ({
      path: resolve(HISTORY_DIR, f),
      timestamp: f.slice(prefix.length),
    }));
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

// ── Typed check API (shared by the check tool and the runtime scheduler) ──

export type SoulGuardianItemStatus = "ok" | "drift" | "error" | "restored";

export interface SoulGuardianCheckItem {
  path: string;
  mode: "restore" | "alert" | "ignore";
  status: SoulGuardianItemStatus;
  /** Present for status === "error". */
  error?: string;
  /** Baseline hash, when known. */
  approvedSha?: string;
  /** Current on-disk hash, when readable. */
  currentSha?: string;
  /** Path to the written unified-diff patch, when drift produced one. */
  patchPath?: string;
  /** Quarantine path of the pre-restore file (restore-mode auto-restore). */
  quarantinePath?: string;
  /** True when this file has drift AND has a usable baseline snapshot to approve against. */
  canApprove: boolean;
}

export interface SoulGuardianCheckResult {
  /** True when nothing needs attention (no drift, no error). */
  ok: boolean;
  items: SoulGuardianCheckItem[];
  /** alert-mode files currently in drift with an approvable baseline. */
  driftFiles: string[];
  /** files reported as errors (missing baseline/file, symlink, etc). Never approvable. */
  errorFiles: string[];
  /** restore-mode files auto-restored this run. */
  restoredFiles: string[];
  /**
   * Stable fingerprint of the current actionable state (drift + error set with current
   * hashes). Identical unresolved drift across runs yields the same fingerprint, which the
   * scheduler uses to avoid re-notifying about an already-open notification.
   */
  fingerprint: string;
}

export interface SoulGuardianCheckOptions {
  /** When true, restore-mode files are NOT auto-restored (check only). */
  noRestore?: boolean;
  /** When true, drift/error/restore events are appended to the audit log. Default true. */
  audit?: boolean;
}

/**
 * Deterministic integrity check. Pure typed result — no string parsing, no LLM. Both the
 * `soul_guardian_check` tool and the gateway scheduler call this so their logic can never
 * diverge. Auto-restore for restore-mode files still happens here unless `noRestore`.
 */
export function runSoulGuardianCheck(options: SoulGuardianCheckOptions = {}): SoulGuardianCheckResult {
  const { noRestore = false, audit = true } = options;
  const baselines = loadBaselines();
  const targets = resolveTargets();
  const items: SoulGuardianCheckItem[] = [];

  for (const t of targets) {
    if (t.mode === "ignore") continue;
    const { drifted: isDrift, info } = detectDrift(t.path, baselines);

    if (!isDrift) {
      items.push({
        path: t.path, mode: t.mode, status: "ok", canApprove: false,
        approvedSha: info.approvedSha as string | undefined,
        currentSha: info.currentSha as string | undefined,
      });
      continue;
    }

    if ("error" in info) {
      if (audit) appendAudit({ ts: utcNowIso(), event: "error", actor: "furet", path: t.path, mode: t.mode, error: info.error });
      items.push({ path: t.path, mode: t.mode, status: "error", error: String(info.error), canApprove: false });
      continue;
    }

    if (audit) appendAudit({ ts: utcNowIso(), event: "drift", actor: "furet", path: t.path, mode: t.mode, ...info });

    if (t.mode === "restore" && !noRestore) {
      const restored = restoreOne(t.path, info);
      if (audit) appendAudit({ ts: utcNowIso(), event: "restore", actor: "furet", path: t.path, mode: t.mode, ...restored });
      items.push({
        path: t.path, mode: t.mode, status: "restored", canApprove: false,
        approvedSha: info.approvedSha as string | undefined,
        currentSha: info.currentSha as string | undefined,
        patchPath: info.patchPath as string | undefined,
        quarantinePath: restored.quarantinePath as string | undefined,
      });
      continue;
    }

    // drift, not restored → approvable (alert mode, or restore mode with noRestore)
    items.push({
      path: t.path, mode: t.mode, status: "drift", canApprove: true,
      approvedSha: info.approvedSha as string | undefined,
      currentSha: info.currentSha as string | undefined,
      patchPath: info.patchPath as string | undefined,
    });
  }

  const driftFiles = items.filter(i => i.status === "drift" && i.canApprove).map(i => i.path);
  const errorFiles = items.filter(i => i.status === "error").map(i => i.path);
  const restoredFiles = items.filter(i => i.status === "restored").map(i => i.path);
  const ok = driftFiles.length === 0 && errorFiles.length === 0;

  // Fingerprint: only the actionable set (drift + error) with current hashes. Restored
  // files are resolved by the time we notify, so they do not enter the dedup identity.
  const fpParts = items
    .filter(i => i.status === "drift" || i.status === "error")
    .map(i => `${i.path}:${i.status}:${i.currentSha ?? i.error ?? ""}`)
    .sort();
  const fingerprint = fpParts.length === 0 ? "clean" : sha256(Buffer.from(fpParts.join("\n"))).slice(0, 32);

  return { ok, items, driftFiles, errorFiles, restoredFiles, fingerprint };
}

/**
 * Given a requested set of files, return those that (a) are monitored non-ignore targets
 * and (b) are currently in drift with an approvable baseline. Used by approve to skip
 * files that were already approved or never drifted — no redundant archive / no-op.
 */
export function resolveApprovableDrift(requested: string[]): { approvable: string[]; skipped: string[] } {
  const result = runSoulGuardianCheck({ noRestore: true, audit: false });
  const driftSet = new Set(result.driftFiles);
  const approvable: string[] = [];
  const skipped: string[] = [];
  for (const f of requested) {
    if (driftSet.has(f)) approvable.push(f);
    else skipped.push(f);
  }
  return { approvable, skipped };
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
      // Shared typed core — the runtime scheduler calls the same function, so the tool
      // and the deterministic monitor can never diverge. No string is parsed downstream.
      const result = runSoulGuardianCheck({ noRestore: no_restore === true });
      if (result.ok && result.restoredFiles.length === 0) {
        return "OK: all monitored files match their baselines.";
      }

      const lines = ["DRIFT DETECTED", ""];
      for (const item of result.items) {
        if (item.status === "ok") continue;
        lines.push(`${item.path} (${item.mode})`);
        if (item.status === "error") lines.push(`  error: ${item.error}`);
        else if (item.status === "restored") lines.push("  -> auto-restored to baseline");
        else lines.push("  -> drift detected (not restored)");
        lines.push("");
      }
      return lines.join("\n");
    } catch (e) { return `Error: ${(e as Error).message}`; }
  },
};

// ── Tool: approve ──

export const soulGuardianApprove: Tool = {
  name: "soul_guardian_approve",
  description: "Approve the current version of monitored file(s) as the new baseline. Accepts `file` (single), `files` (explicit list), or `all` — mutually exclusive. Only files currently in drift are approved; already-approved files are skipped (no redundant archive). OWNER-ONLY: NEVER use this tool unless the owner explicitly instructs you to approve. Do not self-approve after your own edits.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "Single file path to approve (relative to workspace)" },
      files: { type: "array", items: { type: "string" }, description: "Explicit list of file paths to approve. Mutually exclusive with file/all. Only files still in drift are approved." },
      all: { type: "boolean", description: "Approve all monitored files (mutually exclusive with file/files)" },
      note: { type: "string", description: "Reason for this approval" },
    },
    required: ["note"],
  },
  execute: async (args) => {
    const { file, files, all, note } = args as { file?: string; files?: string[]; all?: boolean; note: string };
    const trigger = getTrigger();
    if (!isOwnerIdentity(trigger)) {
      logger.warn({ trigger, file, files, all }, "soul_guardian approve blocked: owner-only");
      return "Error: soul_guardian_approve is owner-only. Only the owner can approve baseline changes.";
    }
    const fileList = Array.isArray(files) ? files.filter(f => typeof f === "string" && f.trim()) : undefined;
    const selectorCount = [file ? 1 : 0, fileList && fileList.length ? 1 : 0, all ? 1 : 0].reduce((a, b) => a + b, 0);
    if (selectorCount === 0) return "Error: must specify file, files, or all";
    if (selectorCount > 1) return "Error: file, files and all are mutually exclusive";
    logger.info({ file, files: fileList, all, note }, "soul_guardian approve");

    try {
      const baselines = loadBaselines();
      const targets = resolveTargets().filter(t => t.mode !== "ignore");

      let chosen: Target[];
      const skippedNoDrift: string[] = [];
      if (all) {
        // "all" still approves only files that are currently in drift. This avoids
        // archiving and rewriting unchanged baselines when an old Approve All button is
        // clicked after some files were already approved individually.
        const requested = targets.map(t => t.path);
        const { approvable, skipped } = resolveApprovableDrift(requested);
        skippedNoDrift.push(...skipped);
        chosen = targets.filter(t => approvable.includes(t.path));
        if (!chosen.length) return "No files needed approval; all monitored files are already at baseline.";
      } else {
        const requested = fileList ?? [file!];
        const known = new Set(targets.map(t => t.path));
        const unknown = requested.filter(f => !known.has(f));
        if (unknown.length) return `Error: not found in policy or ignored: ${unknown.join(", ")}`;
        // Only approve files currently in drift; skip files already at baseline so we do
        // not archive/no-op an unchanged file (e.g. "approve all" after some individual
        // approves, or a stale button click).
        const { approvable, skipped } = resolveApprovableDrift(requested);
        skippedNoDrift.push(...skipped);
        chosen = targets.filter(t => approvable.includes(t.path));
        if (!chosen.length) {
          const msg = skippedNoDrift.length
            ? `No files needed approval (already at baseline): ${skippedNoDrift.join(", ")}`
            : "No matching files in drift to approve.";
          return msg;
        }
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
        const histPath = archiveSnapshot(t.path);
        atomicWrite(snap, curBytes);

        baselines.files[t.path] = { sha256: curSha, approvedAt: utcNowIso() };

        appendAudit({
          ts: utcNowIso(), event: "approve", actor: "furet", note,
          path: t.path, mode: t.mode, prevApprovedSha: prevSha, approvedSha: curSha, patchPath,
          ...(histPath ? { historyPath: histPath } : {}),
        });

        results.push(`✅ ${t.path}: sha256=${curSha.slice(0, 16)}...`);
      }

      saveBaselines(baselines);
      for (const sk of skippedNoDrift) results.push(`⏭️ ${sk}: already at baseline (skipped)`);
      return results.join("\n");
    } catch (e) { return `Error: ${(e as Error).message}`; }
  },
};

// ── Tool: restore ──

export const soulGuardianRestore: Tool = {
  name: "soul_guardian_restore",
  description: "Manually restore a file. Defaults to last approved baseline; use 'version' to restore from history. OWNER-ONLY.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "File path to restore (relative to workspace)" },
      all: { type: "boolean", description: "Restore all monitored files to baseline (mutually exclusive with file)" },
      version: { type: "string", description: "History version timestamp to restore (from soul_guardian_history). If omitted, restores to latest approved baseline." },
      note: { type: "string", description: "Reason for this restore" },
    },
    required: ["note"],
  },
  execute: async (args) => {
    const { file, all, version, note } = args as { file?: string; all?: boolean; version?: string; note: string };
    const trigger = getTrigger();
    if (!isOwnerIdentity(trigger)) {
      logger.warn({ trigger, file, all }, "soul_guardian restore blocked: owner-only");
      return "Error: soul_guardian_restore is owner-only. Only the owner can trigger manual restores.";
    }
    if (!file && !all) return "Error: must specify file or all";
    if (file && all) return "Error: file and all are mutually exclusive";
    if (version && all) return "Error: version cannot be used with all";
    logger.info({ file, all, version, note }, "soul_guardian restore");

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

        // Determine source: history version or approved snapshot
        let sourceBytes: Buffer;
        let sourceLabel: string;
        if (version) {
          const hist = listHistory(t.path);
          const match = hist.find(h => h.timestamp === version);
          if (!match) return `Error: version ${version} not found for ${t.path}. Use soul_guardian_history to list.`;
          sourceBytes = readFileSync(match.path);
          sourceLabel = `history/${version}`;
        } else {
          const snap = approvedSnapshotPath(t.path);
          if (!existsSync(snap)) { results.push(`${t.path}: no approved snapshot`); continue; }
          sourceBytes = readFileSync(snap);
          sourceLabel = "approved";
        }

        // Quarantine current file before restoring
        if (existsSync(abs) && !isSymlink(abs)) {
          ensureDir(QUARANTINE_DIR);
          const fileTag = safePatchTag(t.path.replace(/\//g, "_"));
          const quarantinePath = resolve(QUARANTINE_DIR, `${fileTag}.${tsTag()}.quarantine`);
          atomicWrite(quarantinePath, readFileSync(abs));
        }

        atomicWrite(abs, sourceBytes);

        // If restoring from history, also update baseline to match
        if (version) {
          const newSha = sha256(sourceBytes);
          baselines.files[t.path] = { sha256: newSha, approvedAt: utcNowIso() };
          const snap = approvedSnapshotPath(t.path);
          ensureDir(dirname(snap));
          archiveSnapshot(t.path);
          atomicWrite(snap, sourceBytes);
        }

        appendAudit({
          ts: utcNowIso(), event: "restore", actor: "furet", note,
          path: t.path, mode: t.mode, source: sourceLabel,
        });
        results.push(`${t.path}: restored from ${sourceLabel}`);
      }

      if (version) saveBaselines(baselines);
      return results.join("\n") || "No files needed restoring.";
    } catch (e) { return `Error: ${(e as Error).message}`; }
  },
};

// ── Tool: history ──

export const soulGuardianHistory: Tool = {
  name: "soul_guardian_history",
  description: "List historical approved versions of a monitored file. Each version can be restored using soul_guardian_restore with the version timestamp.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "File path (relative to workspace)" },
    },
    required: ["file"],
  },
  execute: async (args) => {
    const { file } = args as { file: string };
    logger.info({ file }, "soul_guardian history");
    try {
      const hist = listHistory(file);
      if (hist.length === 0) return `No history found for ${file}.`;

      const lines = [`History for ${file} (${hist.length} versions, newest first):`, ""];
      for (const h of hist) {
        const bytes = readFileSync(h.path);
        const hash = sha256(bytes);
        lines.push(`- ${h.timestamp}  sha256=${hash.slice(0, 16)}...  (${bytes.length} bytes)`);
      }
      return lines.join("\n");
    } catch (e) { return `Error: ${(e as Error).message}`; }
  },
};
