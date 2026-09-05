import { readFileSync, writeFileSync, statSync } from "node:fs";
import { parse, stringify } from "yaml";
import { CONFIG_PATH } from "./paths.js";
import "dotenv/config";
import type { LlmAuthStrategy, LlmCapability, LlmProfile, LlmProtocol, TokenLimitField } from "./llm/types.js";
import type { ToolActivityPools } from "./utils/tool-activity.js";

/** One private plugin entry. `path` may be absolute or relative to the Umiro root. */
export interface PluginConfig {
  /** Path to the plugin module (absolute, or relative to the Umiro root). */
  path: string;
  /** Whether to load this plugin. Disabled plugins are skipped entirely. */
  enabled: boolean;
}

export const REASONING_EFFORTS = ["default", "none", "auto", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export interface UmiroConfig {
  llm: {
    active_profile: string;
    profiles: Record<string, Omit<LlmProfile, "name">>;
    maxContextTokens: number;
    memoryCharLimit: number;
  };
  discord: {
    enabled: boolean;
    token: string;
    allowed_channels: string[];
    /**
     * 這些頻道不需 @ bot 即會回應。只精確比對 channel ID，thread 不繼承。
     * 是否回應其他 bot 仍依 `respond_to_bots`。
     */
    ambient_channels: string[];
    /**
     * 完全忽略的 channel / thread ID。命中時在訊息入口最早期直接放棄，
     * 既不觸發也不記錄——即使該訊息 @ bot、reply bot、來自 DM，或該頻道
     * 之後被列入 `ambient_channels`。只精確比對 channel/thread ID 本身，
     * thread 不繼承 parent。優先權高於所有其他觸發條件。
     */
    ignored_channels: string[];
    allowed_guilds: string[];
    owner_id: string;
    status: string;
    activity: string;
    respond_to_bots: boolean;
    /** Default handling for a new trigger while the same session is running. */
    queue_mode: import("./types.js").DiscordQueueMode;
    tool_activity: {
      enabled: boolean;
      mode: "append" | "replace";
      /** Optional YAML/JSON pool file. Relative paths resolve from the Umiro root. */
      pools_file: string;
      pools: ToolActivityPools;
    };
  };
  journal: {
    enabled: boolean;
    hour: number;
    minute: number;
    /** Dedicated model for journal work. Empty = active profile default. */
    model: string;
  };
  soul_guardian: {
    /**
     * Deterministic built-in integrity monitor. When enabled, the gateway schedules
     * file-integrity checks itself (no cron -> LLM -> tool -> LLM -> Discord round-trip).
     * The LLM never decides whether to check or whether to notify.
     * Safe defaults: disabled, and no notification is attempted while channel_id is empty.
     */
    enabled: boolean;
    /** node-cron expression driving the built-in scheduler (e.g. "0 8,20 * * *"). */
    schedule: string;
    /** IANA timezone for the schedule. Empty falls back to the global `timezone`. */
    timezone: string;
    /** Discord channel/thread ID that drift/error alerts are sent to. Empty = never notify. */
    channel_id: string;
    targets: { path: string; mode: "restore" | "alert" | "ignore" }[];
  };
  tools: {
    /** bash 是沒有沙箱的任意指令執行，預設只有 owner 能用 */
    bash_owner_only: boolean;
    /**
     * `bash_owner_only: true` 時的例外人員：這些 Discord user ID 也能用 bash。
     * 空陣列＝只有 owner。CLI / cron / reminder / journal / plugin 不受此限制。
     * 只放寬 bash，不等於 owner——其他 owner-only 工具仍然擋。
     */
    bash_allowed_users: string[];
    /**
     * Tool exposure grading. Off = every tool's full schema is sent each turn
     * (legacy behavior). On = only native + matched tools carry schema; the rest are
     * reached through tool_catalog. Exposure is visibility, not permission.
     */
    exposure: {
      enabled: boolean;
      /** Cap on how many `match`-level tools are exposed per turn (native excluded). */
      max_matched_tools: number;
    };
  };
  image_generation: {
    /** Optional canonical identity image, relative to the Umiro root or absolute. */
    identity_reference_path: string;
  };
  /**
   * Vision / attachment analysis. Governs the background attachment-index worker's OCR +
   * visual-description + document-extraction pipeline. DELIBERATELY independent of the
   * interactive chat model: background attachment analysis uses the active LLM profile.
   * Endpoint credentials may be overridden, but the model may not be silently changed. Requests
   * use the active profile protocol.
   */
  attachment_analysis: {
    /** Master switch for background visual description. OCR/document text still run when off. */
    enabled: boolean;
    /** Vision endpoint base URL. Empty = inherit the active profile base URL. */
    base_url: string;
    /**
     * Vision API key ENV VAR NAME (not the secret). Resolved from process.env at load time.
     * Empty = inherit the active profile API key. Storing only the var name avoids a second on-disk secret.
     */
    api_key_env: string;
    /** Max simultaneous attachment jobs the worker runs. */
    concurrency: number;
    /** Max successful visual descriptions per local day. 0 = unlimited. Exhaustion is refreshable, not a permanent job failure. */
    daily_budget: number;
    /** Per-request vision timeout (ms). */
    timeout_ms: number;
    /** Max image bytes eligible for visual description. Larger images skip vision (OCR still runs). */
    max_image_bytes: number;
    /** Cap on generated description length (provider max_completion_tokens). */
    max_output_tokens: number;
    /**
     * Language the description is written in, e.g. "Traditional Chinese". Empty = no language
     * directive, letting the model answer in the language the image and prompt imply.
     */
    language: string;
  };
  prompt: {
    /**
     * PEOPLE.md 內嵌進 system prompt 的字元上限。
     * 超過就只放一行指標，讓 agent 需要時自己 read_file。0 = 永不內嵌。
     */
    peopleInlineLimit: number;
    relevantPeople: {
      enabled: boolean;
      maxEntries: number;
      maxChars: number;
      recentUserMessages: number;
    };
  };
  skills: string[];
  /**
   * 私有外掛清單（預設空）。每筆指定本機 `path`（絕對或相對 Umiro root）與 `enabled`。
   * 外掛可註冊額外工具、背景排程與事件 handler；載入時機與權限見 DESIGN.md。
   * 不要把任何私人連線資料寫進 repo——外掛模組自己從 .env / 私有設定讀。
   */
  plugins: PluginConfig[];
  /** IANA 時區名（如 "Asia/Taipei"）。留空 = 用系統時區 */
  timezone: string;
}

const DEFAULTS: UmiroConfig = {
  llm: {
    active_profile: "default",
    profiles: {
      default: {
        protocol: "openai_chat_completions",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        auth: "bearer",
        model: "gpt-4.1-mini",
        reasoningEffort: "default",
        tokenLimitField: "max_completion_tokens",
        capabilities: {
          vision: true,
          function_tools: true,
          responses: false,
          hosted_web_search: false,
          hosted_image_generation: false,
          hosted_code_execution: false,
        },
      },
    },
    maxContextTokens: 150_000,
    memoryCharLimit: 3000,
  },
  discord: {
    enabled: false,
    token: "",
    allowed_channels: [],
    ambient_channels: [],
    ignored_channels: [],
    allowed_guilds: [],
    owner_id: "",
    status: "online",
    activity: "Burrowing around…🦦✨",
    respond_to_bots: false,
    queue_mode: "followup",
    tool_activity: {
      enabled: true,
      mode: "append",
      pools_file: "",
      pools: {},
    },
  },
  journal: {
    enabled: false,
    hour: 22,
    minute: 0,
    model: "",
  },
  soul_guardian: {
    enabled: false,
    schedule: "0 8,20 * * *",
    timezone: "",
    channel_id: "",
    targets: [],
  },
  tools: {
    bash_owner_only: true,
    bash_allowed_users: [],
    exposure: {
      enabled: false,
      max_matched_tools: 12,
    },
  },
  image_generation: {
    identity_reference_path: "",
  },
  attachment_analysis: {
    // Off unless a workspace opts in: vision needs a model the configured endpoint actually
    // serves, and a wrong guess fails silently inside a background job.
    enabled: false,
    base_url: "",
    api_key_env: "",
    concurrency: 2,
    daily_budget: 0,
    timeout_ms: 60_000,
    max_image_bytes: 20 * 1024 * 1024,
    max_output_tokens: 1200,
    language: "",
  },
  prompt: {
    peopleInlineLimit: 1500,
    relevantPeople: {
      enabled: true,
      maxEntries: 8,
      maxChars: 6000,
      recentUserMessages: 6,
    },
  },
  skills: [],
  plugins: [],
  timezone: "",
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

/** Clamp a possibly-invalid number to [min, max], falling back to `fallback` for
 *  empty/NaN/non-finite/negative-out-of-range values. */
function sanitizeInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/**
 * Merge the nested `tools` block with a deep pass on `exposure`. A shallow spread would
 * let a user who writes only `exposure: { enabled: true }` drop `max_matched_tools`
 * into undefined; here we merge exposure key-by-key and sanitize the cap.
 */
const LLM_PROTOCOLS = new Set<LlmProtocol>(["openai_chat_completions", "openai_responses"]);
const LLM_AUTHS = new Set<LlmAuthStrategy>(["bearer", "none"]);
const TOKEN_LIMIT_FIELDS = new Set<TokenLimitField>(["max_completion_tokens", "max_tokens"]);
const CAPABILITIES: LlmCapability[] = ["vision", "function_tools", "responses", "hosted_web_search", "hosted_image_generation", "hosted_code_execution"];

function normalizeProfile(name: string, raw: unknown, fallback?: Omit<LlmProfile, "name">): Omit<LlmProfile, "name"> | null {
  const value = defined(raw);
  const base = fallback ?? DEFAULTS.llm.profiles.default;
  const protocol = LLM_PROTOCOLS.has(value.protocol as LlmProtocol) ? value.protocol as LlmProtocol : base.protocol;
  const auth = LLM_AUTHS.has(value.auth as LlmAuthStrategy) ? value.auth as LlmAuthStrategy : base.auth;
  const reasoningEffort = REASONING_EFFORTS.includes(value.reasoningEffort as ReasoningEffort)
    ? value.reasoningEffort as ReasoningEffort
    : base.reasoningEffort;
  const tokenLimitField = TOKEN_LIMIT_FIELDS.has(value.tokenLimitField as TokenLimitField)
    ? value.tokenLimitField as TokenLimitField
    : base.tokenLimitField;
  const rawCapabilities = defined(value.capabilities);
  const capabilities = Object.fromEntries(CAPABILITIES.map(capability => [
    capability,
    typeof rawCapabilities[capability] === "boolean" ? rawCapabilities[capability] : base.capabilities[capability],
  ])) as Record<LlmCapability, boolean>;
  const model = typeof value.model === "string" ? value.model.trim() : base.model;
  if (!model) return null;
  return {
    protocol,
    baseUrl: typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl.trim().replace(/\/+$/, "") : base.baseUrl,
    apiKey: typeof value.apiKey === "string" ? value.apiKey : base.apiKey,
    auth,
    model,
    reasoningEffort,
    tokenLimitField,
    capabilities,
  };
}

export function normalizeLlmConfig(resolvedLlm: unknown): UmiroConfig["llm"] {
  const raw = defined(resolvedLlm);
  const maxContextTokens = sanitizeInt(raw.maxContextTokens, DEFAULTS.llm.maxContextTokens, 8_000, 2_000_000);
  const memoryCharLimit = sanitizeInt(raw.memoryCharLimit, DEFAULTS.llm.memoryCharLimit, 500, 100_000);
  const rawProfiles = defined(raw.profiles);
  const profiles: UmiroConfig["llm"]["profiles"] = {};
  for (const [name, profile] of Object.entries(rawProfiles)) {
    const normalized = normalizeProfile(name, profile);
    if (normalized) profiles[name] = normalized;
  }

  if (Object.keys(profiles).length === 0) {
    if (Object.keys(raw).length === 0) profiles.default = { ...DEFAULTS.llm.profiles.default };
    else throw new Error("llm.profiles must define at least one valid connection profile");
  }

  const requestedActive = typeof raw.active_profile === "string" ? raw.active_profile.trim() : "";
  const active_profile = requestedActive && profiles[requestedActive] ? requestedActive : Object.keys(profiles)[0];
  return { active_profile, profiles, maxContextTokens, memoryCharLimit };
}

function mergeToolsConfig(resolvedTools: unknown): UmiroConfig["tools"] {
  const top = defined(resolvedTools);
  const rawExposure = defined(top.exposure);
  delete top.exposure;
  const exposure = {
    enabled: typeof rawExposure.enabled === "boolean"
      ? rawExposure.enabled
      : DEFAULTS.tools.exposure.enabled,
    max_matched_tools: sanitizeInt(
      rawExposure.max_matched_tools,
      DEFAULTS.tools.exposure.max_matched_tools,
      1,
      50,
    ),
  };
  return { ...DEFAULTS.tools, ...top, exposure } as UmiroConfig["tools"];
}

/**
 * Normalize the `plugins` list. Anything that is not an object with a non-empty string
 * `path` is dropped (a malformed entry must not crash config load). `enabled` defaults
 * to `true` when omitted so an author can just list a path; set `false` to keep the entry
 * around but skip loading. Path resolution against the Umiro root happens in the loader.
 */
function mergePluginsConfig(resolvedPlugins: unknown): PluginConfig[] {
  if (!Array.isArray(resolvedPlugins)) return [];
  const out: PluginConfig[] = [];
  for (const entry of resolvedPlugins) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const path = typeof e.path === "string" ? e.path.trim() : "";
    if (!path) continue;
    const enabled = typeof e.enabled === "boolean" ? e.enabled : true;
    out.push({ path, enabled });
  }
  return out;
}

/**
 * Merge the `soul_guardian` block. Top-level scalar fields fall back to defaults; the
 * `targets` list is validated entry-by-entry so a malformed target cannot crash config
 * load (or worse, silently monitor nothing). An entry must have a non-empty string
 * `path` and a valid `mode`; anything else is dropped. Missing/invalid `targets` keeps
 * the default (empty) list rather than throwing.
 */
function mergeSoulGuardianConfig(resolved: unknown): UmiroConfig["soul_guardian"] {
  const top = defined(resolved);
  const rawTargets = top.targets;
  delete top.targets;
  const merged = { ...DEFAULTS.soul_guardian, ...top } as UmiroConfig["soul_guardian"];

  const validModes = ["restore", "alert", "ignore"] as const;
  const targets: UmiroConfig["soul_guardian"]["targets"] = [];
  if (Array.isArray(rawTargets)) {
    for (const entry of rawTargets) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const path = typeof e.path === "string" ? e.path.trim() : "";
      const mode = e.mode as UmiroConfig["soul_guardian"]["targets"][number]["mode"];
      if (!path || !validModes.includes(mode)) continue;
      targets.push({ path, mode });
    }
  }
  merged.targets = targets;
  // Normalize scalar string fields (yaml may hand back non-strings).
  merged.enabled = typeof merged.enabled === "boolean" ? merged.enabled : DEFAULTS.soul_guardian.enabled;
  merged.schedule = typeof merged.schedule === "string" && merged.schedule.trim() ? merged.schedule : DEFAULTS.soul_guardian.schedule;
  merged.timezone = typeof merged.timezone === "string" ? merged.timezone : DEFAULTS.soul_guardian.timezone;
  merged.channel_id = typeof merged.channel_id === "string" ? merged.channel_id.trim() : DEFAULTS.soul_guardian.channel_id;
  return merged;
}

/**
 * Merge the `attachment_analysis` block. Every field falls back to a safe default; the
 * numeric fields are clamped. Attachment analysis inherits the active profile model and protocol. base_url/api_key_env may override endpoint credentials without changing the model.
 */
function mergeAttachmentAnalysisConfig(resolved: unknown): UmiroConfig["attachment_analysis"] {
  const top = defined(resolved);
  const d = DEFAULTS.attachment_analysis;
  return {
    enabled: typeof top.enabled === "boolean" ? top.enabled : d.enabled,
    base_url: typeof top.base_url === "string" ? top.base_url.trim() : d.base_url,
    api_key_env: typeof top.api_key_env === "string" ? top.api_key_env.trim() : d.api_key_env,
    concurrency: sanitizeInt(top.concurrency, d.concurrency, 1, 16),
    daily_budget: sanitizeInt(top.daily_budget, d.daily_budget, 0, 1_000_000),
    timeout_ms: sanitizeInt(top.timeout_ms, d.timeout_ms, 5_000, 600_000),
    max_image_bytes: sanitizeInt(top.max_image_bytes, d.max_image_bytes, 64 * 1024, 64 * 1024 * 1024),
    max_output_tokens: sanitizeInt(top.max_output_tokens, d.max_output_tokens, 64, 8_000),
    language: typeof top.language === "string" ? top.language.trim() : d.language,
  };
}

function mergePromptConfig(resolved: unknown): UmiroConfig["prompt"] {
  const top = defined(resolved);
  const rawRelevant = defined(top.relevantPeople);
  const d = DEFAULTS.prompt;
  return {
    peopleInlineLimit: sanitizeInt(top.peopleInlineLimit, d.peopleInlineLimit, 0, 100_000),
    relevantPeople: {
      enabled: typeof rawRelevant.enabled === "boolean" ? rawRelevant.enabled : d.relevantPeople.enabled,
      maxEntries: sanitizeInt(rawRelevant.maxEntries, d.relevantPeople.maxEntries, 1, 32),
      maxChars: sanitizeInt(rawRelevant.maxChars, d.relevantPeople.maxChars, 500, 50_000),
      recentUserMessages: sanitizeInt(rawRelevant.recentUserMessages, d.relevantPeople.recentUserMessages, 0, 50),
    },
  };
}


function mergeDiscordConfig(resolved: unknown): UmiroConfig["discord"] {
  const top = defined(resolved);
  const rawToolActivity = defined(top.tool_activity);
  delete top.tool_activity;
  const rawPools = defined(rawToolActivity.pools);
  const pools = Object.fromEntries(Object.entries(rawPools).flatMap(([key, value]) => {
    if (!Array.isArray(value)) return [];
    const lines = value.filter((line): line is string => typeof line === "string");
    return [[key, lines]];
  }));
  const queueMode = top.queue_mode === "steer" ? "steer" : "followup";
  return {
    ...DEFAULTS.discord,
    ...top,
    queue_mode: queueMode,
    tool_activity: {
      enabled: typeof rawToolActivity.enabled === "boolean"
        ? rawToolActivity.enabled
        : DEFAULTS.discord.tool_activity.enabled,
      mode: rawToolActivity.mode === "replace" ? "replace" : "append",
      pools_file: typeof rawToolActivity.pools_file === "string"
        ? rawToolActivity.pools_file.trim()
        : DEFAULTS.discord.tool_activity.pools_file,
      pools,
    },
  } as UmiroConfig["discord"];
}

function mergeJournalConfig(resolved: unknown): UmiroConfig["journal"] {
  const top = defined(resolved);
  const d = DEFAULTS.journal;
  return {
    enabled: typeof top.enabled === "boolean" ? top.enabled : d.enabled,
    hour: sanitizeInt(top.hour, d.hour, 0, 23),
    minute: sanitizeInt(top.minute, d.minute, 0, 59),
    model: typeof top.model === "string" ? top.model.trim() : d.model,
  };
}

let cached: UmiroConfig | null = null;
let cachedMtimeMs = 0;

export function loadConfig(): UmiroConfig {
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
    llm: normalizeLlmConfig(resolved.llm),
    discord: mergeDiscordConfig(resolved.discord),
    journal: mergeJournalConfig(resolved.journal),
    soul_guardian: mergeSoulGuardianConfig(resolved.soul_guardian),
    tools: mergeToolsConfig(resolved.tools),
    image_generation: { ...DEFAULTS.image_generation, ...defined(resolved.image_generation) } as UmiroConfig["image_generation"],
    attachment_analysis: mergeAttachmentAnalysisConfig(resolved.attachment_analysis),
    prompt: mergePromptConfig(resolved.prompt),
    skills: (resolved.skills as string[] | undefined) ?? DEFAULTS.skills,
    plugins: mergePluginsConfig(resolved.plugins),
    timezone: (resolved.timezone as string | undefined) ?? DEFAULTS.timezone,
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

/**
 * Save the local installer's Discord identity and optionally their first allowed
 * channel. This runs from the host CLI before the gateway accepts Discord traffic.
 */
export function configureInitialDiscordOwner(ownerId: string, channelId?: string): void {
  let raw: Record<string, unknown> = {};
  try { raw = (parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>) ?? {}; } catch {}
  const discord = (raw.discord as Record<string, unknown>) ?? {};
  discord.owner_id = ownerId;
  // Re-running `umiro onbord` is an intentional full setup pass: a blank
  // channel answer clears the initial channel restriction rather than keeping
  // an old value invisibly.
  discord.allowed_channels = channelId ? [channelId] : [];
  raw.discord = discord;
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

function mutatePluginConfig(mutator: (plugins: PluginConfig[]) => PluginConfig[]): void {
  let raw: Record<string, unknown> = {};
  try { raw = (parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>) ?? {}; } catch {}
  raw.plugins = mutator(mergePluginsConfig(raw.plugins));
  writeFileSync(CONFIG_PATH, stringify(raw, { lineWidth: 0 }));
  cached = null;
}

/** Register a plugin module path, or update its enabled state if already present. */
export function upsertPluginConfig(path: string, enabled = true): void {
  mutatePluginConfig((plugins) => {
    const existing = plugins.find((plugin) => plugin.path === path);
    if (existing) existing.enabled = enabled;
    else plugins.push({ path, enabled });
    return plugins;
  });
}

/** Toggle a registered plugin. Returns false when the path was not registered. */
export function setPluginConfigEnabled(path: string, enabled: boolean): boolean {
  let found = false;
  mutatePluginConfig((plugins) => plugins.map((plugin) => {
    if (plugin.path !== path) return plugin;
    found = true;
    return { ...plugin, enabled };
  }));
  return found;
}

/** Remove a plugin path from config.yaml. */
export function removePluginConfig(path: string): void {
  mutatePluginConfig((plugins) => plugins.filter((plugin) => plugin.path !== path));
}
