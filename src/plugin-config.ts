import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { PLUGIN_CONFIG_DIR } from "./paths.js";

export interface PluginConfigStore {
  /** Absolute path of this plugin's private YAML configuration file. */
  readonly path: string;
  /** Read the YAML object and merge it recursively over the supplied defaults. */
  read<T extends Record<string, unknown>>(defaults: T): T;
  /** Atomically replace the YAML object. */
  write(value: Record<string, unknown>): void;
  /** Atomically update the YAML object and return the saved value. */
  update<T extends Record<string, unknown>>(
    defaults: T,
    updater: (current: T) => Record<string, unknown>,
  ): T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRecords<T extends Record<string, unknown>>(defaults: T, value: unknown): T {
  if (!isRecord(value)) return structuredClone(defaults);
  const output: Record<string, unknown> = structuredClone(defaults);
  for (const [key, item] of Object.entries(value)) {
    const fallback = output[key];
    output[key] = isRecord(fallback) && isRecord(item)
      ? mergeRecords(fallback, item)
      : structuredClone(item);
  }
  return output as T;
}

function safePluginName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(`plugin name ${JSON.stringify(name)} cannot be used as a config filename`);
  }
  return name;
}

function readYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = YAML.parse(readFileSync(path, "utf8")) as unknown;
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) throw new Error(`plugin config must contain a YAML object: ${path}`);
  return parsed;
}

function writeYaml(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    writeFileSync(temp, YAML.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    }
  }
}

export function pluginConfigPath(pluginName: string): string {
  return resolve(PLUGIN_CONFIG_DIR, `${safePluginName(pluginName)}.yaml`);
}

export function createPluginConfigStore(pluginName: string): PluginConfigStore {
  const path = pluginConfigPath(pluginName);
  if (!existsSync(path)) writeYaml(path, {});
  return {
    path,
    read<T extends Record<string, unknown>>(defaults: T): T {
      return mergeRecords(defaults, readYaml(path));
    },
    write(value: Record<string, unknown>): void {
      if (!isRecord(value)) throw new Error("plugin config must be an object");
      writeYaml(path, value);
    },
    update<T extends Record<string, unknown>>(
      defaults: T,
      updater: (current: T) => Record<string, unknown>,
    ): T {
      const next = updater(mergeRecords(defaults, readYaml(path)));
      if (!isRecord(next)) throw new Error("plugin config updater must return an object");
      writeYaml(path, next);
      return mergeRecords(defaults, next);
    },
  };
}
