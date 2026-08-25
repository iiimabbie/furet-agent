import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { logger } from "../logger.js";
import { loadConfig, type PluginConfig } from "../config.js";
import { ROOT } from "../paths.js";
import type { Tool } from "../types.js";
import type { ExposureLevel, MatchSignalName } from "./metadata.js";
import type { PluginManifest, PluginModule, PluginToolRegistration } from "./plugin-types.js";
import { registerPluginTools, hasToolName, setPluginToolsActive } from "./registry.js";

/**
 * Plugin loader + lifecycle.
 *
 * Design constraints (see DESIGN.md › Plugin 系統):
 * - Loading a plugin NEVER crashes the gateway. Every failure path (missing file, bad
 *   default export, invalid tool schema, duplicate name, model gate misuse) is logged
 *   with `logger.error` and the plugin is skipped; the rest of the process starts.
 * - Relative `path` is resolved against the Furet root (`ROOT`), explicitly and safely —
 *   never against the current working directory, which drifts.
 * - No circular import: this loader imports the registry to push registrations, but the
 *   registry never imports this loader. The registry only exposes `registerPluginTools`
 *   and `hasToolName`.
 */

const VALID_EXPOSURE: ExposureLevel[] = ["native", "match", "index", "on-demand"];

/** A successfully loaded plugin, retained so we can run its `stop` hook on shutdown. */
interface LoadedPlugin {
  manifest: PluginManifest;
  /** Resolved absolute module path, for diagnostics. */
  resolvedPath: string;
  toolNames: string[];
  state: "loaded" | "started" | "failed";
}

const PLUGIN_START_TIMEOUT_MS = 10_000;
const VALID_SIGNALS: MatchSignalName[] = ["hasDateTime", "hasAttachment", "hasImageEditRequest"];

let loaded: LoadedPlugin[] = [];
let didLoad = false;

/** Resolve a config path against the Furet root; absolute paths pass through. */
function resolvePluginPath(rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(ROOT, rawPath);
}

/** Shallow structural check that an imported value looks like a `Tool`. */
function isTool(value: unknown): value is Tool {
  if (value === null || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.name === "string" &&
    t.name.length > 0 &&
    typeof t.description === "string" &&
    typeof t.parameters === "object" &&
    t.parameters !== null &&
    typeof t.execute === "function"
  );
}

/**
 * Validate one plugin tool registration. Returns an error string when invalid, or null
 * when it is safe to register. Name-uniqueness is checked against the live registry AND
 * the names already accepted from this same plugin batch (`seen`).
 */
function validatePluginTool(
  reg: unknown,
  seen: Set<string>,
): { ok: true; value: PluginToolRegistration } | { ok: false; error: string } {
  if (reg === null || typeof reg !== "object") {
    return { ok: false, error: "registration is not an object" };
  }
  const r = reg as Record<string, unknown>;
  if (!isTool(r.tool)) {
    return { ok: false, error: "registration.tool is not a valid Tool (name/description/parameters/execute)" };
  }
  const tool = r.tool as Tool;
  const name = tool.name;

  if (typeof r.group !== "string" || r.group.length === 0) {
    return { ok: false, error: `tool ${name}: group is required and must be a non-empty string` };
  }

  const exposure = (r.exposure ?? "on-demand") as ExposureLevel;
  if (!VALID_EXPOSURE.includes(exposure)) {
    return { ok: false, error: `tool ${name}: invalid exposure "${String(r.exposure)}"` };
  }

  // Global name uniqueness: never allow a plugin to shadow a builtin or another plugin.
  if (hasToolName(name) || seen.has(name)) {
    return { ok: false, error: `tool ${name}: duplicate tool name (already registered)` };
  }

  if (
    r.keywords !== undefined &&
    (!Array.isArray(r.keywords) || r.keywords.some(v => typeof v !== "string" || v.trim().length === 0))
  ) {
    return { ok: false, error: `tool ${name}: keywords must be an array of non-empty strings` };
  }
  if (
    r.aliases !== undefined &&
    (!Array.isArray(r.aliases) || r.aliases.some(v => typeof v !== "string" || v.trim().length === 0))
  ) {
    return { ok: false, error: `tool ${name}: aliases must be an array of non-empty strings` };
  }
  if (
    r.signals !== undefined &&
    (!Array.isArray(r.signals) || r.signals.some(v => !VALID_SIGNALS.includes(v as MatchSignalName)))
  ) {
    return { ok: false, error: `tool ${name}: signals must contain only ${VALID_SIGNALS.join(", ")}` };
  }
  if (
    exposure === "match" &&
    ((r.keywords as string[] | undefined)?.length ?? 0) === 0 &&
    ((r.aliases as string[] | undefined)?.length ?? 0) === 0 &&
    ((r.signals as MatchSignalName[] | undefined)?.length ?? 0) === 0
  ) {
    return { ok: false, error: `tool ${name}: match exposure requires at least one keyword, alias, or signal` };
  }
  if (r.modelPredicate !== undefined && typeof r.modelPredicate !== "function") {
    return { ok: false, error: `tool ${name}: modelPredicate must be a function` };
  }
  if (r.ownerOnly !== undefined && typeof r.ownerOnly !== "boolean") {
    return { ok: false, error: `tool ${name}: ownerOnly must be a boolean` };
  }

  return {
    ok: true,
    value: {
      tool,
      exposure,
      group: r.group as string,
      keywords: r.keywords as string[] | undefined,
      aliases: r.aliases as string[] | undefined,
      signals: r.signals as MatchSignalName[] | undefined,
      modelPredicate: r.modelPredicate as ((model: string) => boolean) | undefined,
      // Plugin tools default to owner-only unless the author explicitly opts out.
      ownerOnly: r.ownerOnly === false ? false : true,
    },
  };
}

/** Read `.manifest` / `.tools` from either the module namespace or its default export. */
function extractModule(mod: Record<string, unknown>): PluginModule | null {
  const candidate =
    (mod.manifest && mod.tools ? mod : (mod.default as Record<string, unknown> | undefined)) ?? null;
  if (!candidate) return null;
  const c = candidate as Record<string, unknown>;
  const manifest = c.manifest as PluginManifest | undefined;
  const tools = c.tools as unknown;
  if (!manifest || typeof manifest !== "object") return null;
  if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) return null;
  if (manifest.start !== undefined && typeof manifest.start !== "function") return null;
  if (manifest.stop !== undefined && typeof manifest.stop !== "function") return null;
  if (!Array.isArray(tools)) return null;
  return { manifest: manifest as PluginManifest, tools: tools as PluginToolRegistration[] };
}

/** Load and register one plugin entry. Never throws — logs and returns on failure. */
async function loadOne(entry: PluginConfig): Promise<void> {
  const resolvedPath = resolvePluginPath(entry.path);

  if (!existsSync(resolvedPath)) {
    logger.error({ plugin: entry.path, resolvedPath }, "plugin path does not exist; skipping");
    return;
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(resolvedPath).href)) as Record<string, unknown>;
  } catch (err) {
    logger.error({ plugin: entry.path, resolvedPath, err }, "plugin import failed; skipping");
    return;
  }

  const parsed = extractModule(mod);
  if (!parsed) {
    logger.error(
      { plugin: entry.path, resolvedPath },
      "plugin module does not export a valid { manifest: { name }, tools: [] }; skipping",
    );
    return;
  }

  const { manifest, tools } = parsed;

  // Validate every tool BEFORE registering any of them: a plugin is all-or-nothing so a
  // half-registered plugin can't leave dangling names or partial capability.
  const seen = new Set<string>();
  const accepted: PluginToolRegistration[] = [];
  for (const rawReg of tools) {
    const result = validatePluginTool(rawReg, seen);
    if (!result.ok) {
      logger.error({ plugin: manifest.name, resolvedPath, reason: result.error }, "plugin tool rejected; skipping whole plugin");
      return;
    }
    seen.add(result.value.tool.name);
    accepted.push(result.value);
  }

  try {
    // A plugin with a start hook is registered inactive: its names are reserved, but
    // schemas/catalog entries stay hidden and execution is denied until start succeeds.
    registerPluginTools(accepted, { active: manifest.start === undefined });
  } catch (err) {
    // registerPluginTools re-validates uniqueness under a lock; treat any throw as fatal
    // for this plugin only.
    logger.error({ plugin: manifest.name, resolvedPath, err }, "plugin registration failed; skipping");
    return;
  }

  loaded.push({
    manifest,
    resolvedPath,
    toolNames: accepted.map(r => r.tool.name),
    state: manifest.start ? "loaded" : "started",
  });
  logger.info(
    { plugin: manifest.name, resolvedPath, toolCount: accepted.length },
    "plugin loaded",
  );
}

/**
 * Load all enabled plugins from config. Idempotent within a process: a second call is a
 * no-op (registrations already applied). Call this once, early, before serving traffic.
 */
export async function loadPlugins(): Promise<void> {
  if (didLoad) return;
  didLoad = true;
  const { plugins } = loadConfig();
  const enabled = plugins.filter(p => p.enabled);
  if (enabled.length === 0) {
    logger.info("no plugins enabled");
    return;
  }
  for (const entry of enabled) {
    await loadOne(entry);
  }
  logger.info({ requested: enabled.length, loaded: loaded.length }, "plugin loading complete");
}

/**
 * Run each loaded plugin's optional `start()` hook. Failures are isolated per plugin: a
 * throw is logged and does not stop the other plugins from starting. Loads plugins first
 * if not already loaded.
 */
export async function startPlugins(): Promise<void> {
  if (!didLoad) await loadPlugins();
  for (const p of loaded) {
    if (!p.manifest.start || p.state !== "loaded") continue;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => p.manifest.start!()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`plugin start timed out after ${PLUGIN_START_TIMEOUT_MS}ms`)),
            PLUGIN_START_TIMEOUT_MS,
          );
        }),
      ]);
      if (timer) clearTimeout(timer);
      setPluginToolsActive(p.toolNames, true);
      p.state = "started";
      logger.info({ plugin: p.manifest.name }, "plugin started");
    } catch (err) {
      if (timer) clearTimeout(timer);
      setPluginToolsActive(p.toolNames, false);
      p.state = "failed";
      logger.error({ plugin: p.manifest.name, err }, "plugin start failed (isolated)");
    }
  }
}

/**
 * Run each loaded plugin's optional `stop()` hook. Called on gateway shutdown / SIGINT /
 * SIGTERM. Failures are isolated per plugin. Best-effort and synchronous-safe: the caller
 * (signal handler) may `process.exit` right after; each stop is awaited but a hang in one
 * plugin should not be relied upon to block exit indefinitely.
 */
export async function stopPlugins(): Promise<void> {
  for (const p of loaded) {
    if (!p.manifest.stop) continue;
    try {
      await p.manifest.stop();
      logger.info({ plugin: p.manifest.name }, "plugin stopped");
    } catch (err) {
      logger.error({ plugin: p.manifest.name, err }, "plugin stop failed (isolated)");
    }
  }
}
