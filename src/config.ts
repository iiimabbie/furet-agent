import { readFileSync, writeFileSync, statSync } from "node:fs";
import { parse, stringify } from "yaml";
import { CONFIG_PATH } from "./paths.js";
import "dotenv/config";

export interface FuretConfig {
  llm: {
    api_key: string;
    base_url: string;
    currentModel: string;
    modelList: string[];
    maxContextTokens: number;
    memoryCharLimit: number;
    codingModel: string;
  };
  discord: {
    enabled: boolean;
    token: string;
    allowed_channels: string[];
    allowed_guilds: string[];
    owner_id: string;
    status: string;
    activity: string;
    respond_to_bots: boolean;
  };
  journal: {
    enabled: boolean;
    hour: number;
    minute: number;
  };
  soul_guardian: {
    targets: { path: string; mode: "restore" | "alert" | "ignore" }[];
  };
  skills: string[];
}

const DEFAULTS: FuretConfig = {
  llm: {
    api_key: "",
    base_url: "",
    currentModel: "claude-sonnet-4-20250514",
    modelList: [],
    maxContextTokens: 150_000,
    memoryCharLimit: 3000,
    codingModel: "",  // 空字串 = 使用 currentModel
  },
  discord: {
    enabled: false,
    token: "",
    allowed_channels: [],
    allowed_guilds: [],
    owner_id: "",
    status: "online",
    activity: "Burrowing around…🦦✨",
    respond_to_bots: false,
  },
  journal: {
    enabled: false,
    hour: 22,
    minute: 0,
  },
  soul_guardian: {
    targets: [],
  },
  skills: [],
};

function resolveEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

/** 過濾掉 null/undefined，避免 yaml 空值（`key:`）覆蓋掉預設值 */
function defined(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined)
  );
}

let cached: FuretConfig | null = null;
let cachedMtimeMs = 0;

export function loadConfig(): FuretConfig {
  // 有 cache 時檢查 mtime，沒變就直接回傳
  if (cached) {
    try {
      const stat = statSync(CONFIG_PATH);
      if (stat.mtimeMs === cachedMtimeMs) return cached;
    } catch {
      return cached;
    }
  }

  let raw: Record<string, unknown> = {};
  try {
    const stat = statSync(CONFIG_PATH);
    cachedMtimeMs = stat.mtimeMs;
    const content = readFileSync(CONFIG_PATH, "utf-8");
    raw = (parse(content) as Record<string, unknown>) ?? {};
  } catch {
    // config.yaml 不存在就用預設值
  }

  const resolved = resolveEnvVars(raw) as Record<string, unknown>;

  cached = {
    llm: { ...DEFAULTS.llm, ...defined(resolved.llm) } as FuretConfig["llm"],
    discord: { ...DEFAULTS.discord, ...defined(resolved.discord) } as FuretConfig["discord"],
    journal: { ...DEFAULTS.journal, ...defined(resolved.journal) } as FuretConfig["journal"],
    soul_guardian: { ...DEFAULTS.soul_guardian, ...defined(resolved.soul_guardian) } as FuretConfig["soul_guardian"],
    skills: (resolved.skills as string[] | undefined) ?? DEFAULTS.skills,
  };

  return cached!;
}

export function addSkill(name: string): void {
  let raw: Record<string, unknown> = {};
  try { raw = (parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>) ?? {}; } catch {}
  const skills = (raw.skills as string[] | undefined) ?? [];
  if (!skills.includes(name)) skills.push(name);
  raw.skills = skills;
  writeFileSync(CONFIG_PATH, stringify(raw, { lineWidth: 0 }));
  cached = null;
}

export function removeSkill(name: string): void {
  let raw: Record<string, unknown> = {};
  try { raw = (parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>) ?? {}; } catch {}
  const skills = (raw.skills as string[] | undefined) ?? [];
  raw.skills = skills.filter(s => s !== name);
  writeFileSync(CONFIG_PATH, stringify(raw, { lineWidth: 0 }));
  cached = null;
}

export function setCurrentModel(model: string): void {
  let raw: Record<string, unknown> = {};
  try {
    raw = (parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>) ?? {};
  } catch {}
  const llm = (raw.llm as Record<string, unknown>) ?? {};
  llm.currentModel = model;
  raw.llm = llm;
  writeFileSync(CONFIG_PATH, stringify(raw, { lineWidth: 0 }));
  cached = null;
}

export function setRespondToBots(enabled: boolean): void {
  let raw: Record<string, unknown> = {};
  try {
    raw = (parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>) ?? {};
  } catch {}
  const discord = (raw.discord as Record<string, unknown>) ?? {};
  discord.respond_to_bots = enabled;
  raw.discord = discord;
  writeFileSync(CONFIG_PATH, stringify(raw, { lineWidth: 0 }));
  cached = null;
}
