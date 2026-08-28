import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
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

const EMPTY_REGISTRY: PluginRegistry = { version: 1, sources: [], plugins: [] };

function ensureManagedDirs(): void {
  mkdirSync(PLUGINS_DIR, { recursive: true });
  mkdirSync(dirname(PLUGIN_REGISTRY_FILE), { recursive: true });
  mkdirSync(TRASH_DIR, { recursive: true });
}

function readRegistry(): PluginRegistry {
  try {
    const parsed = JSON.parse(readFileSync(PLUGIN_REGISTRY_FILE, "utf-8")) as Partial<PluginRegistry>;
    if (parsed.version !== 1 || !Array.isArray(parsed.sources) || !Array.isArray(parsed.plugins)) {
      throw new Error("unsupported registry format");
    }
    const registry = parsed as PluginRegistry;
    registry.plugins = registry.plugins.map((plugin) => ({ ...plugin, enabled: plugin.enabled !== false }));
    return registry;
  } catch (error) {
    if (!existsSync(PLUGIN_REGISTRY_FILE)) return structuredClone(EMPTY_REGISTRY);
    throw new Error(`Cannot read plugin registry: ${(error as Error).message}`);
  }
}

function writeRegistry(registry: PluginRegistry): void {
  ensureManagedDirs();
  const temp = `${PLUGIN_REGISTRY_FILE}.tmp`;
  writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, PLUGIN_REGISTRY_FILE);
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

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
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
  if (!workspace) return sourceRoot;

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
  run("npm", ["install", "--no-audit", "--no-fund"], sourceRoot);
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

export async function installPlugin(source: string, options: InstallPluginOptions = {}): Promise<string> {
  ensureManagedDirs();
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

  const sourceRoot = resolve(ROOT, sourceRecord.directory);
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
    const entry = displayPath(metadata.entryPath);
    registry.plugins.push({
      name: metadata.name,
      enabled: true,
      sourceId: sourceRecord.id,
      workspace: displayPath(packageRoot).replace(`${sourceRecord.directory}${sep}`, ""),
      packageName: metadata.packageName,
      entry,
      installedAt: now,
      updatedAt: now,
    });
    writeRegistry(registry);
    return `Installed ${metadata.name} from ${sourceRecord.id}. Restart Furet to load it.`;
  } catch (error) {
    if (createdSource) {
      const index = registry.sources.findIndex((item) => item.id === sourceRecord?.id);
      if (index >= 0) registry.sources.splice(index, 1);
      const sourceRoot = resolve(ROOT, sourceRecord.directory);
      if (existsSync(sourceRoot)) {
        const trash = resolve(TRASH_DIR, `plugin-install-failed-${sourceRecord.id}-${Date.now()}`);
        renameSync(sourceRoot, trash);
      }
    }
    throw error;
  }
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
  const registry = readRegistry();
  const plugin = registry.plugins.find((item) => item.name === name);
  if (!plugin) throw new Error(`Managed plugin ${name} is not installed`);
  plugin.enabled = enabled;
  writeRegistry(registry);
  return `${enabled ? "Enabled" : "Disabled"} ${name}. Restart Furet to apply the change.`;
}

async function updateSource(registry: PluginRegistry, source: ManagedPluginSource): Promise<void> {
  const sourceRoot = resolve(ROOT, source.directory);
  if (!existsSync(sourceRoot)) throw new Error(`Plugin source directory is missing: ${source.directory}`);
  if (source.local) throw new Error(`Cannot update copied local source ${source.id}; remove and install it again`);
  run("git", ["pull", "--ff-only"], sourceRoot);
  installDependencies(sourceRoot);
  for (const plugin of registry.plugins.filter((item) => item.sourceId === source.id)) {
    const packageRoot = resolve(sourceRoot, plugin.workspace === source.directory ? "." : plugin.workspace);
    buildPackage(sourceRoot, packageRoot, plugin.packageName);
    const metadata = pluginMetadata(packageRoot);
    if (metadata.name !== plugin.name || displayPath(metadata.entryPath) !== plugin.entry) {
      throw new Error(`Plugin identity or entry changed for ${plugin.name}; remove and install it again`);
    }
    assertEntryExists(packageRoot, metadata.entryPath);
    plugin.updatedAt = new Date().toISOString();
  }
}

export async function updatePlugins(name?: string): Promise<string> {
  const registry = readRegistry();
  if (!registry.plugins.length) return "No managed plugins installed.";
  const sources = name
    ? (() => {
        const plugin = registry.plugins.find((item) => item.name === name);
        if (!plugin) throw new Error(`Managed plugin ${name} is not installed`);
        return registry.sources.filter((item) => item.id === plugin.sourceId);
      })()
    : registry.sources;
  for (const source of sources) await updateSource(registry, source);
  writeRegistry(registry);
  return `Updated ${name ?? `${sources.length} plugin source${sources.length === 1 ? "" : "s"}`}. Restart Furet to load the new code.`;
}

export function removeManagedPlugin(name: string): string {
  const registry = readRegistry();
  const index = registry.plugins.findIndex((item) => item.name === name);
  if (index < 0) throw new Error(`Managed plugin ${name} is not installed`);
  const [plugin] = registry.plugins.splice(index, 1);

  const sourceStillUsed = registry.plugins.some((item) => item.sourceId === plugin.sourceId);
  if (!sourceStillUsed) {
    const sourceIndex = registry.sources.findIndex((item) => item.id === plugin.sourceId);
    if (sourceIndex >= 0) {
      const [source] = registry.sources.splice(sourceIndex, 1);
      const sourceRoot = resolve(ROOT, source.directory);
      if (existsSync(sourceRoot)) {
        const trash = resolve(TRASH_DIR, `plugin-${source.id}-${Date.now()}`);
        renameSync(sourceRoot, trash);
      }
    }
  }
  writeRegistry(registry);
  const sourceNote = sourceStillUsed
    ? "The shared source checkout was kept because another plugin still uses it."
    : "The unused source checkout was moved to workspace/.trash/.";
  return `Removed ${name}. ${sourceNote} Restart Furet to apply the change.`;
}
