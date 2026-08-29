import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { loadConfig, type PluginConfig } from "./config.js";
import { PLUGINS_DIR, PLUGIN_REGISTRY_FILE, ROOT, TRASH_DIR } from "./paths.js";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  furet?: {
    name?: string;
    plugin?: string;
  };
}

interface ManagedPluginSource {
  id: string;
  source: string;
  directory: string;
  local: boolean;
  ref?: string;
}

interface ManagedPlugin {
  name: string;
  enabled: boolean;
  sourceId: string;
  workspace: string;
  packageName: string;
  entry: string;
  installedAt: string;
  updatedAt: string;
}

interface PluginRegistry {
  version: 1;
  sources: ManagedPluginSource[];
  plugins: ManagedPlugin[];
}

export interface InstallPluginOptions {
  workspace?: string;
  ref?: string;
}

interface PreparedUpdate {
  source: ManagedPluginSource;
  sourceRoot: string;
  stagedRoot: string;
  backupRoot: string;
  swapped: boolean;
}

const EMPTY_REGISTRY: PluginRegistry = { version: 1, sources: [], plugins: [] };
const REGISTRY_LOCK_FILE = `${PLUGIN_REGISTRY_FILE}.lock`;

function ensureManagedDirs(): void {
  mkdirSync(PLUGINS_DIR, { recursive: true });
  mkdirSync(dirname(PLUGIN_REGISTRY_FILE), { recursive: true });
  mkdirSync(TRASH_DIR, { recursive: true });
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function assertManagedPath(path: string, label: string): string {
  const absolute = resolve(ROOT, path);
  if (!isInside(PLUGINS_DIR, absolute)) throw new Error(`${label} escapes workspace/plugins`);
  return absolute;
}

function validateRegistry(value: unknown): PluginRegistry {
  if (value === null || typeof value !== "object") throw new Error("registry root is not an object");
  const parsed = value as Partial<PluginRegistry>;
  if (parsed.version !== 1 || !Array.isArray(parsed.sources) || !Array.isArray(parsed.plugins)) {
    throw new Error("unsupported registry format");
  }

  const sourceIds = new Set<string>();
  for (const source of parsed.sources) {
    if (
      source === null || typeof source !== "object" ||
      typeof source.id !== "string" || !source.id ||
      typeof source.source !== "string" || !source.source ||
      typeof source.directory !== "string" || !source.directory ||
      typeof source.local !== "boolean" ||
      (source.ref !== undefined && typeof source.ref !== "string")
    ) {
      throw new Error("registry contains an invalid source record");
    }
    if (sourceIds.has(source.id)) throw new Error(`registry contains duplicate source id ${source.id}`);
    sourceIds.add(source.id);
    assertManagedPath(source.directory, `source ${source.id}`);
  }

  const pluginNames = new Set<string>();
  for (const plugin of parsed.plugins) {
    if (
      plugin === null || typeof plugin !== "object" ||
      typeof plugin.name !== "string" || !plugin.name ||
      typeof plugin.sourceId !== "string" || !sourceIds.has(plugin.sourceId) ||
      typeof plugin.workspace !== "string" || !plugin.workspace ||
      typeof plugin.packageName !== "string" || !plugin.packageName ||
      typeof plugin.entry !== "string" || !plugin.entry ||
      typeof plugin.installedAt !== "string" ||
      typeof plugin.updatedAt !== "string"
    ) {
      throw new Error("registry contains an invalid plugin record");
    }
    if (pluginNames.has(plugin.name)) throw new Error(`registry contains duplicate plugin name ${plugin.name}`);
    pluginNames.add(plugin.name);
    const source = parsed.sources.find(item => item.id === plugin.sourceId)!;
    const sourceRoot = assertManagedPath(source.directory, `source ${source.id}`);
    const entry = assertManagedPath(plugin.entry, `plugin ${plugin.name} entry`);
    if (!isInside(sourceRoot, entry)) throw new Error(`plugin ${plugin.name} entry escapes its source checkout`);
    plugin.enabled = plugin.enabled !== false;
  }

  return parsed as PluginRegistry;
}

function readRegistry(): PluginRegistry {
  try {
    return validateRegistry(JSON.parse(readFileSync(PLUGIN_REGISTRY_FILE, "utf-8")) as unknown);
  } catch (error) {
    if (!existsSync(PLUGIN_REGISTRY_FILE)) return structuredClone(EMPTY_REGISTRY);
    throw new Error(`Cannot read plugin registry: ${(error as Error).message}`);
  }
}

function writeRegistry(registry: PluginRegistry): void {
  ensureManagedDirs();
  validateRegistry(registry);
  const temp = `${PLUGIN_REGISTRY_FILE}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, PLUGIN_REGISTRY_FILE);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function acquireRegistryLock(): number {
  ensureManagedDirs();
  try {
    return openSync(REGISTRY_LOCK_FILE, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error("Another plugin management operation is already running; try again shortly");
    throw error;
  }
}

function releaseRegistryLock(fd: number): void {
  closeSync(fd);
  try {
    unlinkSync(REGISTRY_LOCK_FILE);
  } catch {
    // A missing lock after close does not invalidate the completed operation.
  }
}

function withRegistryLock<T>(operation: () => T): T {
  const fd = acquireRegistryLock();
  try {
    return operation();
  } finally {
    releaseRegistryLock(fd);
  }
}

async function withRegistryLockAsync<T>(operation: () => Promise<T>): Promise<T> {
  const fd = acquireRegistryLock();
  try {
    return await operation();
  } finally {
    releaseRegistryLock(fd);
  }
}

function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): void {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", npm_config_yes: "true", ...extraEnv },
  });
}

function safeSegment(value: string): string {
  const segment = value
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .toLowerCase();
  if (!segment) throw new Error(`Cannot derive a safe name from ${JSON.stringify(value)}`);
  return segment;
}

function sourceBaseName(source: string): string {
  const normalized = source.replace(/[\\/]+$/, "");
  const tail = normalized.split(/[\\/:]/).filter(Boolean).at(-1) ?? "plugin";
  return safeSegment(tail);
}

function isLocalDirectory(source: string): boolean {
  try {
    return statSync(resolve(source)).isDirectory();
  } catch {
    return false;
  }
}

function readPackage(packageRoot: string): PackageJson {
  const path = resolve(packageRoot, "package.json");
  if (!existsSync(path)) throw new Error(`No package.json found at ${packageRoot}`);
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PackageJson;
  } catch (error) {
    throw new Error(`Invalid package.json at ${packageRoot}: ${(error as Error).message}`);
  }
}

function findPackageRoots(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = resolve(dir, entry.name);
      if (entry.isFile() && entry.name === "package.json") results.push(dir);
      if (entry.isDirectory()) walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return [...new Set(results)];
}

function resolvePackageRoot(sourceRoot: string, workspace?: string): string {
  if (!workspace || workspace === ".") return sourceRoot;

  const pathCandidate = resolve(sourceRoot, workspace);
  if (isInside(sourceRoot, pathCandidate) && existsSync(resolve(pathCandidate, "package.json"))) {
    const realSource = realpathSync(sourceRoot);
    const realCandidate = realpathSync(pathCandidate);
    if (!isInside(realSource, realCandidate)) throw new Error("Workspace path escapes the plugin source");
    return realCandidate;
  }

  const matches = findPackageRoots(sourceRoot).filter((root) => {
    const pkg = readPackage(root);
    return pkg.name === workspace || basename(root) === workspace;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Workspace ${workspace} is ambiguous; use its relative path instead`);
  throw new Error(`Workspace ${workspace} was not found in ${sourceRoot}`);
}

function pluginMetadata(packageRoot: string): { name: string; packageName: string; entryPath: string } {
  const pkg = readPackage(packageRoot);
  const entry = pkg.furet?.plugin?.trim();
  if (!entry) {
    throw new Error(`package.json must declare \"furet\": { \"plugin\": \"./path/to/entry.js\" }`);
  }
  if (entry.startsWith("/") || entry.split(/[\\/]/).includes("..")) {
    throw new Error("furet.plugin must be a relative path inside its package");
  }
  const packageName = pkg.name?.trim() || basename(packageRoot);
  const name = safeSegment(pkg.furet?.name?.trim() || packageName.replace(/^@[^/]+\//, ""));
  const entryPath = resolve(packageRoot, entry);
  if (!isInside(packageRoot, entryPath)) throw new Error("Plugin entry escapes its package directory");
  return { name, packageName, entryPath };
}

function assertEntryExists(packageRoot: string, entryPath: string): void {
  if (!existsSync(entryPath)) throw new Error(`Plugin entry does not exist after install/build: ${entryPath}`);
  const realPackage = realpathSync(packageRoot);
  const realEntry = realpathSync(entryPath);
  if (!isInside(realPackage, realEntry)) throw new Error("Plugin entry symlink escapes its package directory");
}

function installDependencies(sourceRoot: string): void {
  if (!existsSync(resolve(sourceRoot, "package.json"))) return;
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts=false"], sourceRoot);
}

function buildPackage(sourceRoot: string, packageRoot: string, packageName: string): void {
  const pkg = readPackage(packageRoot);
  if (!pkg.scripts?.build) return;
  if (packageRoot === sourceRoot) {
    run("npm", ["run", "build"], packageRoot);
  } else {
    run("npm", ["run", "build", "--workspace", packageName], sourceRoot);
  }
}

async function checkoutSource(source: string, destination: string, ref?: string): Promise<boolean> {
  const local = isLocalDirectory(source);
  if (local) {
    cpSync(realpathSync(resolve(source)), destination, { recursive: true });
  } else {
    const args = ["clone", "--depth", "1"];
    if (ref) args.push("--branch", ref);
    args.push(source, destination);
    run("git", args, ROOT);
  }
  return local;
}

function displayPath(absolutePath: string): string {
  const rel = relative(ROOT, absolutePath);
  return rel && !rel.startsWith("..") ? rel : absolutePath;
}

function moveToTrash(path: string, label: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const destination = resolve(TRASH_DIR, `${label}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  renameSync(path, destination);
  return destination;
}

export async function installPlugin(source: string, options: InstallPluginOptions = {}): Promise<string> {
  return withRegistryLockAsync(async () => {
    const registry = readRegistry();
    const normalizedSource = isLocalDirectory(source) ? realpathSync(resolve(source)) : source;
    const requestedRef = options.ref?.trim() || undefined;
    let sourceRecord = registry.sources.find((item) => item.source === normalizedSource && item.ref === requestedRef);
    let createdSource = false;

    if (!sourceRecord) {
      const base = sourceBaseName(source);
      let id = base;
      let suffix = 2;
      while (registry.sources.some((item) => item.id === id) || existsSync(resolve(PLUGINS_DIR, id))) {
        id = `${base}-${suffix++}`;
      }
      const directory = resolve(PLUGINS_DIR, id);
      const local = await checkoutSource(source, directory, requestedRef);
      sourceRecord = { id, source: normalizedSource, directory: displayPath(directory), local, ...(requestedRef ? { ref: requestedRef } : {}) };
      registry.sources.push(sourceRecord);
      createdSource = true;
    }

    const sourceRoot = assertManagedPath(sourceRecord.directory, `source ${sourceRecord.id}`);
    try {
      const packageRoot = resolvePackageRoot(sourceRoot, options.workspace);
      installDependencies(sourceRoot);
      const beforeBuild = pluginMetadata(packageRoot);
      buildPackage(sourceRoot, packageRoot, beforeBuild.packageName);
      const metadata = pluginMetadata(packageRoot);
      assertEntryExists(packageRoot, metadata.entryPath);
      if (registry.plugins.some((item) => item.name === metadata.name)) {
        throw new Error(`Plugin ${metadata.name} is already installed`);
      }

      const now = new Date().toISOString();
      registry.plugins.push({
        name: metadata.name,
        enabled: true,
        sourceId: sourceRecord.id,
        workspace: relative(sourceRoot, packageRoot) || ".",
        packageName: metadata.packageName,
        entry: displayPath(metadata.entryPath),
        installedAt: now,
        updatedAt: now,
      });
      writeRegistry(registry);
      return `已安裝外掛「${metadata.name}」。請執行 /restart 載入外掛。`;
    } catch (error) {
      if (createdSource) {
        const index = registry.sources.findIndex((item) => item.id === sourceRecord.id);
        if (index >= 0) registry.sources.splice(index, 1);
        moveToTrash(sourceRoot, `plugin-install-failed-${sourceRecord.id}`);
      }
      throw error;
    }
  });
}

export function listManagedPluginNames(): string[] {
  return readRegistry().plugins.map(plugin => plugin.name).sort();
}

/** Runtime plugin entries managed by workspace/config/plugins.json. */
export function getManagedPluginConfigs(): PluginConfig[] {
  return readRegistry().plugins.map((plugin) => ({ path: plugin.entry, enabled: plugin.enabled }));
}

export function listPlugins(): string {
  const registry = readRegistry();
  const configured = loadConfig().plugins;
  const managedPaths = new Set(registry.plugins.map((plugin) => plugin.entry));
  const lines = registry.plugins.map((plugin) => {
    const source = registry.sources.find((item) => item.id === plugin.sourceId);
    return `${plugin.name} [${plugin.enabled ? "enabled" : "disabled"}] — ${plugin.entry} — ${source?.source ?? plugin.sourceId}`;
  });
  for (const plugin of configured) {
    if (!managedPaths.has(plugin.path)) {
      lines.push(`manual [${plugin.enabled ? "enabled" : "disabled"}] — ${plugin.path}`);
    }
  }
  return lines.length ? lines.join("\n") : "No plugins installed or configured.";
}

export function setManagedPluginEnabled(name: string, enabled: boolean): string {
  return withRegistryLock(() => {
    const registry = readRegistry();
    const plugin = registry.plugins.find((item) => item.name === name);
    if (!plugin) throw new Error(`Managed plugin ${name} is not installed`);
    plugin.enabled = enabled;
    writeRegistry(registry);
    return `${enabled ? "已啟用" : "已停用"}外掛「${name}」。請執行 /restart 套用變更。`;
  });
}

async function prepareSourceUpdate(registry: PluginRegistry, source: ManagedPluginSource): Promise<PreparedUpdate> {
  const sourceRoot = assertManagedPath(source.directory, `source ${source.id}`);
  if (!existsSync(sourceRoot)) throw new Error(`Plugin source directory is missing: ${source.directory}`);
  if (source.local) throw new Error(`Cannot update copied local source ${source.id}; remove and install it again`);

  const stagedRoot = resolve(PLUGINS_DIR, `.update-${source.id}-${randomUUID()}`);
  const backupRoot = resolve(TRASH_DIR, `plugin-update-backup-${source.id}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  try {
    await checkoutSource(source.source, stagedRoot, source.ref);
    installDependencies(stagedRoot);
    for (const plugin of registry.plugins.filter((item) => item.sourceId === source.id)) {
      const workspace = plugin.workspace === source.directory ? "." : plugin.workspace;
      const packageRoot = resolvePackageRoot(stagedRoot, workspace);
      const beforeBuild = pluginMetadata(packageRoot);
      buildPackage(stagedRoot, packageRoot, beforeBuild.packageName);
      const metadata = pluginMetadata(packageRoot);
      const oldEntryRelative = relative(sourceRoot, resolve(ROOT, plugin.entry));
      const newEntryRelative = relative(stagedRoot, metadata.entryPath);
      if (metadata.name !== plugin.name || oldEntryRelative !== newEntryRelative) {
        throw new Error(`Plugin identity or entry changed for ${plugin.name}; remove and install it again`);
      }
      assertEntryExists(packageRoot, metadata.entryPath);
      plugin.packageName = metadata.packageName;
      plugin.workspace = relative(stagedRoot, packageRoot) || ".";
      plugin.updatedAt = new Date().toISOString();
    }
    return { source, sourceRoot, stagedRoot, backupRoot, swapped: false };
  } catch (error) {
    moveToTrash(stagedRoot, `plugin-update-failed-${source.id}`);
    throw error;
  }
}

export async function updatePlugins(name?: string): Promise<string> {
  return withRegistryLockAsync(async () => {
    const registry = readRegistry();
    if (!registry.plugins.length) return "目前沒有已安裝的 managed 外掛。";
    const sources = name
      ? (() => {
          const plugin = registry.plugins.find((item) => item.name === name);
          if (!plugin) throw new Error(`Managed plugin ${name} is not installed`);
          return registry.sources.filter((item) => item.id === plugin.sourceId);
        })()
      : registry.sources;

    const prepared: PreparedUpdate[] = [];
    try {
      for (const source of sources) prepared.push(await prepareSourceUpdate(registry, source));
      for (const update of prepared) {
        renameSync(update.sourceRoot, update.backupRoot);
        try {
          renameSync(update.stagedRoot, update.sourceRoot);
          update.swapped = true;
        } catch (error) {
          renameSync(update.backupRoot, update.sourceRoot);
          throw error;
        }
      }
      writeRegistry(registry);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const update of [...prepared].reverse()) {
        try {
          if (update.swapped) {
            moveToTrash(update.sourceRoot, `plugin-update-rollback-${update.source.id}`);
            renameSync(update.backupRoot, update.sourceRoot);
          } else {
            moveToTrash(update.stagedRoot, `plugin-update-aborted-${update.source.id}`);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], "Plugin update failed and one or more source checkouts could not be restored");
      }
      throw error;
    }

    const label = name ? `外掛「${name}」` : `${sources.length} 個外掛來源`;
    return `已更新${label}。請執行 /restart 載入新版本。`;
  });
}

export function removeManagedPlugin(name: string): string {
  return withRegistryLock(() => {
    const registry = readRegistry();
    const index = registry.plugins.findIndex((item) => item.name === name);
    if (index < 0) throw new Error(`Managed plugin ${name} is not installed`);
    const [plugin] = registry.plugins.splice(index, 1);

    const sourceStillUsed = registry.plugins.some((item) => item.sourceId === plugin.sourceId);
    let moved: { original: string; trash: string } | undefined;
    if (!sourceStillUsed) {
      const sourceIndex = registry.sources.findIndex((item) => item.id === plugin.sourceId);
      if (sourceIndex >= 0) {
        const [source] = registry.sources.splice(sourceIndex, 1);
        const sourceRoot = assertManagedPath(source.directory, `source ${source.id}`);
        if (existsSync(sourceRoot)) {
          const trash = resolve(TRASH_DIR, `plugin-${source.id}-${Date.now()}-${randomUUID().slice(0, 8)}`);
          renameSync(sourceRoot, trash);
          moved = { original: sourceRoot, trash };
        }
      }
    }

    try {
      writeRegistry(registry);
    } catch (error) {
      if (moved) {
        try {
          renameSync(moved.trash, moved.original);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `Plugin removal failed and the checkout could not be restored from ${moved.trash}`);
        }
      }
      throw error;
    }

    const sourceNote = sourceStillUsed
      ? "共用的來源仍有其他外掛使用，因此保留 checkout。"
      : "未使用的來源已移到 workspace/.trash/。";
    return `已卸載外掛「${name}」。${sourceNote}請執行 /restart 套用變更。`;
  });
}
