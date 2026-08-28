import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { schedule, validate as validateCron, type ScheduledTask } from "node-cron";
import { loadConfig, type PluginConfig } from "../config.js";
import { logger } from "../logger.js";
import { getManagedPluginConfigs } from "../plugin-manager.js";
import { ROOT } from "../paths.js";
import type { Tool } from "../types.js";
import type { ExposureLevel, MatchSignalName } from "./metadata.js";
import type {
  PluginEvent,
  PluginEventName,
  PluginEventRegistration,
  PluginManifest,
  PluginModule,
  PluginRuntimeContext,
  PluginRuntimeStatus,
  PluginScheduleRegistration,
  PluginToolRegistration,
} from "./plugin-types.js";
import { hasToolName, registerPluginTools, setPluginToolsActive } from "./registry.js";

const VALID_EXPOSURE: ExposureLevel[] = ["native", "match", "index", "on-demand"];
const VALID_SIGNALS: MatchSignalName[] = ["hasDateTime", "hasAttachment", "hasImageEditRequest"];
const VALID_EVENTS: PluginEventName[] = ["journal:completed"];
const PLUGIN_START_TIMEOUT_MS = 10_000;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

interface LoadedPlugin {
  manifest: PluginManifest;
  resolvedPath: string;
  toolNames: string[];
  schedules: PluginScheduleRegistration[];
  events: PluginEventRegistration[];
  tasks: Map<string, ScheduledTask>;
  state: "loaded" | "started" | "failed";
}

let loaded: LoadedPlugin[] = [];
let didLoad = false;
let runtime: PluginRuntimeContext | null = null;
const runningJobs = new Set<string>();

function resolvePluginPath(rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(ROOT, rawPath);
}

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

function validatePluginTool(
  reg: unknown,
  seen: Set<string>,
): { ok: true; value: PluginToolRegistration } | { ok: false; error: string } {
  if (reg === null || typeof reg !== "object") return { ok: false, error: "registration is not an object" };
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
      ownerOnly: r.ownerOnly === false ? false : true,
    },
  };
}

function validTimeout(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function validateSchedules(raw: unknown): { ok: true; value: PluginScheduleRegistration[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "schedules must be an array" };
  const seen = new Set<string>();
  const schedules: PluginScheduleRegistration[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return { ok: false, error: "schedule registration is not an object" };
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || !ID_PATTERN.test(r.id)) {
      return { ok: false, error: `schedule id "${String(r.id)}" must match ${ID_PATTERN}` };
    }
    if (seen.has(r.id)) return { ok: false, error: `duplicate schedule id "${r.id}"` };
    if (r.name !== undefined && (typeof r.name !== "string" || r.name.trim().length === 0)) {
      return { ok: false, error: `schedule ${r.id}: name must be a non-empty string` };
    }
    if (typeof r.schedule !== "string" || !validateCron(r.schedule)) {
      return { ok: false, error: `schedule ${r.id}: invalid cron expression "${String(r.schedule)}"` };
    }
    if (r.timezone !== undefined && (typeof r.timezone !== "string" || r.timezone.trim().length === 0)) {
      return { ok: false, error: `schedule ${r.id}: timezone must be a non-empty IANA timezone string` };
    }
    if (!validTimeout(r.timeoutMs)) return { ok: false, error: `schedule ${r.id}: timeoutMs must be a positive number` };
    if (typeof r.run !== "function") return { ok: false, error: `schedule ${r.id}: run must be a function` };
    seen.add(r.id);
    schedules.push(item as PluginScheduleRegistration);
  }
  return { ok: true, value: schedules };
}

function validateEvents(raw: unknown): { ok: true; value: PluginEventRegistration[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "events must be an array" };
  const seen = new Set<string>();
  const events: PluginEventRegistration[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return { ok: false, error: "event registration is not an object" };
    const r = item as Record<string, unknown>;
    if (!VALID_EVENTS.includes(r.event as PluginEventName)) {
      return { ok: false, error: `unsupported plugin event "${String(r.event)}"` };
    }
    if (typeof r.id !== "string" || !ID_PATTERN.test(r.id)) {
      return { ok: false, error: `event id "${String(r.id)}" must match ${ID_PATTERN}` };
    }
    const key = `${r.event}:${r.id}`;
    if (seen.has(key)) return { ok: false, error: `duplicate event handler "${key}"` };
    if (!validTimeout(r.timeoutMs)) return { ok: false, error: `event ${key}: timeoutMs must be a positive number` };
    if (typeof r.run !== "function") return { ok: false, error: `event ${key}: run must be a function` };
    seen.add(key);
    events.push(item as PluginEventRegistration);
  }
  return { ok: true, value: events };
}

function extractModule(mod: Record<string, unknown>): PluginModule | null {
  const candidate = (mod.manifest ? mod : (mod.default as Record<string, unknown> | undefined)) ?? null;
  if (!candidate) return null;
  const c = candidate as Record<string, unknown>;
  const manifest = c.manifest as PluginManifest | undefined;
  if (!manifest || typeof manifest !== "object") return null;
  if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) return null;
  if (manifest.start !== undefined && typeof manifest.start !== "function") return null;
  if (manifest.stop !== undefined && typeof manifest.stop !== "function") return null;
  if (c.tools !== undefined && !Array.isArray(c.tools)) return null;
  return {
    manifest,
    tools: (c.tools as PluginToolRegistration[] | undefined) ?? [],
    schedules: c.schedules as PluginScheduleRegistration[] | undefined,
    events: c.events as PluginEventRegistration[] | undefined,
  };
}

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
    logger.error({ plugin: entry.path, resolvedPath }, "plugin module does not export a valid manifest/capability shape; skipping");
    return;
  }
  const { manifest } = parsed;
  if (loaded.some(p => p.manifest.name === manifest.name)) {
    logger.error({ plugin: manifest.name, resolvedPath }, "duplicate plugin manifest name; skipping");
    return;
  }

  const seenTools = new Set<string>();
  const acceptedTools: PluginToolRegistration[] = [];
  for (const rawReg of parsed.tools ?? []) {
    const result = validatePluginTool(rawReg, seenTools);
    if (!result.ok) {
      logger.error({ plugin: manifest.name, resolvedPath, reason: result.error }, "plugin tool rejected; skipping whole plugin");
      return;
    }
    seenTools.add(result.value.tool.name);
    acceptedTools.push(result.value);
  }
  const scheduleResult = validateSchedules(parsed.schedules);
  if (!scheduleResult.ok) {
    logger.error({ plugin: manifest.name, resolvedPath, reason: scheduleResult.error }, "plugin schedule rejected; skipping whole plugin");
    return;
  }
  const eventResult = validateEvents(parsed.events);
  if (!eventResult.ok) {
    logger.error({ plugin: manifest.name, resolvedPath, reason: eventResult.error }, "plugin event rejected; skipping whole plugin");
    return;
  }
  if (acceptedTools.length === 0 && scheduleResult.value.length === 0 && eventResult.value.length === 0) {
    logger.error({ plugin: manifest.name, resolvedPath }, "plugin declares no tools, schedules, or events; skipping");
    return;
  }

  try {
    registerPluginTools(acceptedTools, { active: manifest.start === undefined });
  } catch (err) {
    logger.error({ plugin: manifest.name, resolvedPath, err }, "plugin registration failed; skipping");
    return;
  }

  loaded.push({
    manifest,
    resolvedPath,
    toolNames: acceptedTools.map(r => r.tool.name),
    schedules: scheduleResult.value,
    events: eventResult.value,
    tasks: new Map(),
    state: manifest.start ? "loaded" : "started",
  });
  logger.info({
    plugin: manifest.name,
    resolvedPath,
    toolCount: acceptedTools.length,
    scheduleCount: scheduleResult.value.length,
    eventCount: eventResult.value.length,
  }, "plugin loaded");
}

export async function loadPlugins(): Promise<void> {
  if (didLoad) return;
  didLoad = true;
  const configured = loadConfig().plugins;
  let managed: PluginConfig[] = [];
  try {
    managed = getManagedPluginConfigs();
  } catch (err) {
    logger.error({ err }, "managed plugin registry could not be read; continuing with config.yaml plugins only");
  }
  const merged = new Map<string, PluginConfig>();
  for (const entry of managed) merged.set(entry.path, entry);
  for (const entry of configured) merged.set(entry.path, entry);
  const enabled = [...merged.values()].filter(p => p.enabled);
  if (enabled.length === 0) {
    logger.info("no plugins enabled");
    return;
  }
  for (const entry of enabled) await loadOne(entry);
  logger.info({ requested: enabled.length, loaded: loaded.length }, "plugin loading complete");
}

async function runPluginCallback(
  key: string,
  timeoutMs: number | undefined,
  callback: () => Promise<void> | void,
): Promise<void> {
  if (runningJobs.has(key)) {
    logger.warn({ job: key }, "plugin job tick skipped because the previous run is still active");
    return;
  }
  runningJobs.add(key);
  const limit = timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const timer = setTimeout(() => {
    logger.warn({ job: key, timeoutMs: limit }, "plugin job exceeded timeout (callback continues until it settles)");
  }, limit);
  timer.unref?.();
  try {
    await callback();
    logger.info({ job: key }, "plugin job completed");
  } catch (err) {
    logger.error({ job: key, err }, "plugin job failed (isolated)");
  } finally {
    clearTimeout(timer);
    runningJobs.delete(key);
  }
}

function startPluginSchedules(plugin: LoadedPlugin): void {
  if (!runtime) throw new Error("plugin runtime context is unavailable");
  const created: ScheduledTask[] = [];
  try {
    for (const registration of plugin.schedules) {
      const key = `${plugin.manifest.name}:${registration.id}`;
      const task = schedule(
        registration.schedule,
        () => void runPluginCallback(key, registration.timeoutMs, () => registration.run(runtime!)),
        registration.timezone ? { timezone: registration.timezone } : undefined,
      );
      plugin.tasks.set(registration.id, task);
      created.push(task);
      logger.info({
        plugin: plugin.manifest.name,
        id: registration.id,
        name: registration.name ?? registration.id,
        schedule: registration.schedule,
        timezone: registration.timezone,
      }, "plugin schedule registered");
    }
  } catch (err) {
    for (const task of created) task.stop();
    plugin.tasks.clear();
    throw err;
  }
}

export async function startPlugins(context: PluginRuntimeContext): Promise<void> {
  runtime = context;
  if (!didLoad) await loadPlugins();
  for (const plugin of loaded) {
    if (plugin.state === "failed") continue;
    if (plugin.state === "loaded" && plugin.manifest.start) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => plugin.manifest.start!()),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`plugin start timed out after ${PLUGIN_START_TIMEOUT_MS}ms`)), PLUGIN_START_TIMEOUT_MS);
          }),
        ]);
        if (timer) clearTimeout(timer);
        setPluginToolsActive(plugin.toolNames, true);
        plugin.state = "started";
        logger.info({ plugin: plugin.manifest.name }, "plugin started");
      } catch (err) {
        if (timer) clearTimeout(timer);
        setPluginToolsActive(plugin.toolNames, false);
        plugin.state = "failed";
        logger.error({ plugin: plugin.manifest.name, err }, "plugin start failed (isolated)");
        continue;
      }
    }
    if (plugin.state === "started" && plugin.tasks.size === 0) {
      try {
        startPluginSchedules(plugin);
      } catch (err) {
        setPluginToolsActive(plugin.toolNames, false);
        plugin.state = "failed";
        logger.error({ plugin: plugin.manifest.name, err }, "plugin schedule registration failed (isolated)");
      }
    }
  }
}

export async function emitPluginEvent(payload: PluginEvent): Promise<void> {
  if (!runtime) {
    logger.warn({ event: payload.event }, "plugin event emitted before runtime startup; ignored");
    return;
  }
  const handlers = loaded.flatMap(plugin =>
    plugin.state === "started"
      ? plugin.events.filter(registration => registration.event === payload.event).map(registration => ({ plugin, registration }))
      : [],
  );
  await Promise.all(handlers.map(({ plugin, registration }) => {
    const key = `${plugin.manifest.name}:event:${registration.event}:${registration.id}`;
    return runPluginCallback(key, registration.timeoutMs, () => registration.run(payload, runtime!));
  }));
}

export function getPluginRuntimeStatus(): PluginRuntimeStatus {
  return {
    plugins: loaded.map(plugin => ({
      name: plugin.manifest.name,
      state: plugin.state,
      schedules: plugin.schedules.length,
      events: plugin.events.length,
    })),
    activeSchedules: loaded.reduce((count, plugin) => count + plugin.tasks.size, 0),
    runningJobs: runningJobs.size,
  };
}

export async function stopPlugins(): Promise<void> {
  for (const plugin of loaded) {
    for (const task of plugin.tasks.values()) task.stop();
    plugin.tasks.clear();
  }
  for (const plugin of loaded) {
    if (!plugin.manifest.stop) continue;
    try {
      await plugin.manifest.stop();
      logger.info({ plugin: plugin.manifest.name }, "plugin stopped");
    } catch (err) {
      logger.error({ plugin: plugin.manifest.name, err }, "plugin stop failed (isolated)");
    }
  }
}
