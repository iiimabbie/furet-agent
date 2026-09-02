import type { Tool } from "../types.js";
import { logger } from "../logger.js";
import { loadConfig } from "../config.js";
export { setTrigger, getTrigger } from "./context.js";
import { getTrigger, getUserId, getRequestModel } from "./context.js";
import type { ToolRegistration, ExposureLevel } from "./metadata.js";
import {
  GROUP_LABELS, isGptModel, normalizeForMatch, detectSignals, matchTools,
} from "./metadata.js";
import { createToolCatalog } from "./builtin/tool-catalog.js";
import type { PluginToolRegistration } from "./plugin-types.js";

const OWNER_ONLY_TOOLS = new Set([
  // write_file 沒有路徑邊界，寫得進 src/ 就等於繞過 bash 的 owner-only。
  // 非 owner 也沒有寫任意檔案的正當理由——記人記事走 people_* / memory_*，
  // 那些工具的落點寫死在 paths.ts。read_file 刻意不列在這裡：整個擋掉會讓
  // 陌生人一互動就讀不到當天 daily memory 與 skill，改由 guard.ts 擋路徑。
  "write_file",
  "memory_replace", "memory_remove",
  // people_add / people_update 刻意不列 owner-only：agent 要能在非 owner 講話時
  // 記下對方是誰，鎖起來等於永遠記不了非 owner。真正的權限判定看 config.discord.owner_id，
  // 不是 PEOPLE.md，所以寫入這個檔案不會造成提權。刪除是破壞性的，維持 owner-only。
  "people_remove",
  "cron_create", "cron_delete", "cron_toggle", "cron_update",
  "reminder_create", "reminder_delete",
  "discord_send_message", "discord_send_buttons", "discord_pin", "discord_unpin",
  "discord_create_thread", "discord_create_forum_post", "discord_delete_thread",
  "discord_edit_message", "discord_delete_message", "discord_archive_thread",
  "google_calendar_list_events", "google_calendar_create_event", "google_calendar_update_event", "google_calendar_delete_event",
  "google_gmail_search", "google_gmail_read", "google_gmail_send", "google_gmail_create_draft",
  "google_drive_search", "google_drive_read", "google_drive_upload",
  "google_tasks_list", "google_tasks_create", "google_tasks_complete", "google_tasks_delete",
  "soul_guardian_approve", "soul_guardian_restore",
  "skill_install", "skill_uninstall",
  "self_evolve",
  "discord_bot_mention_toggle",
  "usage_dashboard",
  "image_gen",
]);

import { bash } from "./builtin/bash.js";
import { readFileTool } from "./builtin/read-file.js";
import { writeFileTool } from "./builtin/write-file.js";
import { weather } from "./builtin/weather.js";
import { diaryNote, memorySearch, memoryList, memoryAdd, memoryReplace, memoryRemove } from "./builtin/memory.js";
import { peopleAdd, peopleUpdate, peopleRemove } from "./builtin/people.js";
import { cronCreate, cronList, cronDelete, cronToggle, cronUpdate } from "./builtin/cron.js";
import { reminderCreate, reminderList, reminderDelete } from "./builtin/reminder.js";
import {
  discordFetchMessage, discordSendMessage, discordSendButtons, discordReact, discordFetchChannelMessages,
  discordPin, discordUnpin,
  discordCreateThread, discordCreateForumPost, discordDeleteThread,
  discordEditMessage, discordDeleteMessage, discordAttachToReply, discordArchiveThread,
} from "./builtin/discord.js";
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent } from "./builtin/google-calendar.js";
import { gmailSearch, gmailRead, gmailSend, gmailCreateDraft } from "./builtin/google-gmail.js";
import { driveSearch, driveRead, driveUpload } from "./builtin/google-drive.js";
import { tasksList, tasksCreate, tasksComplete, tasksDelete } from "./builtin/google-tasks.js";
import { soulGuardianStatus, soulGuardianCheck, soulGuardianApprove, soulGuardianRestore, soulGuardianHistory } from "./builtin/soul-guardian.js";
import { skillInstall, skillUninstall, skillList } from "./builtin/skill.js";
import { selfEvolve } from "./builtin/self-evolve.js";
import { discordBotMentionToggle } from "./builtin/bot-config.js";
import { sessionSearch, sessionsByDate, journalTranscriptByDate } from "./builtin/session-search.js";
import { usageDashboard } from "./builtin/dashboard.js";
import { imageGen } from "./builtin/image-gen.js";

/** Small helper to build a registration with defaults. */
function reg(
  tool: Tool,
  exposure: ExposureLevel,
  group: string,
  extra: Partial<Pick<ToolRegistration, "keywords" | "aliases" | "signals" | "modelPredicate">> = {},
): ToolRegistration {
  return { tool, exposure, group, ...extra };
}

/**
 * The registry — single source of truth for tool classification. The `tool_catalog`
 * itself is appended below (always native); it is not listed here because its factory
 * needs a reference to this list.
 */
const baseRegistrations: ToolRegistration[] = [
  // ── native: always exposed ──
  reg(bash, "native", "filesystem-shell"),
  reg(readFileTool, "native", "filesystem-shell"),
  reg(writeFileTool, "native", "filesystem-shell"),
  reg(diaryNote, "native", "memory-people"),
  reg(memorySearch, "native", "memory-people"),
  reg(peopleAdd, "native", "memory-people"),
  reg(peopleUpdate, "native", "memory-people"),
  reg(discordReact, "native", "discord-messages"),
  reg(discordAttachToReply, "native", "discord-messages"),

  // ── match: general & memory ──
  reg(weather, "match", "weather", { keywords: ["天氣", "氣溫", "下雨", "weather", "forecast", "溫度"] }),
  reg(memoryList, "match", "memory-people", { keywords: ["記憶檔", "記憶列表", "memory list", "列出記憶"] }),
  reg(memoryAdd, "match", "memory-people", { keywords: ["長期記憶", "記住", "memory", "記下來", "永久記憶"] }),
  reg(memoryReplace, "match", "memory-people", { keywords: ["更新記憶", "修改記憶", "memory", "改記憶"] }),
  reg(memoryRemove, "match", "memory-people", { keywords: ["刪記憶", "移除記憶", "忘記", "memory"] }),
  reg(peopleRemove, "match", "memory-people", { keywords: ["刪除人物", "移除某人", "people"] }),

  // ── match: schedules ──
  reg(cronCreate, "match", "schedules", { keywords: ["排程", "cron", "每天", "每週", "每周", "定時", "schedule", "recurring"], aliases: ["定期任務"], signals: ["hasDateTime"] }),
  reg(cronList, "match", "schedules", { keywords: ["排程", "cron", "排程列表", "schedule"] }),
  reg(cronDelete, "match", "schedules", { keywords: ["刪排程", "取消排程", "cron", "刪除排程"] }),
  reg(cronToggle, "match", "schedules", { keywords: ["停用排程", "啟用排程", "cron"] }),
  reg(cronUpdate, "match", "schedules", { keywords: ["改排程", "更新排程", "cron"] }),
  reg(reminderCreate, "match", "schedules", { keywords: ["提醒", "remind", "reminder", "提醒我", "幾點叫我", "叫我"], aliases: ["提醒我"], signals: ["hasDateTime"] }),
  reg(reminderList, "match", "schedules", { keywords: ["提醒列表", "reminder", "列出提醒"] }),
  reg(reminderDelete, "match", "schedules", { keywords: ["刪提醒", "取消提醒", "reminder"] }),

  // ── match: discord messages ──
  reg(discordFetchMessage, "match", "discord-messages", { keywords: ["訊息", "message", "抓訊息", "fetch"] }),
  reg(discordFetchChannelMessages, "match", "discord-messages", { keywords: ["頻道訊息", "channel", "抓訊息", "歷史訊息"] }),
  reg(discordSendMessage, "match", "discord-messages", { keywords: ["發訊息", "傳訊息", "send message", "發送"] }),
  reg(discordSendButtons, "match", "discord-messages", { keywords: ["按鈕", "button", "確認", "拒絕", "修改", "互動元件"] }),
  reg(discordPin, "match", "discord-messages", { keywords: ["釘選", "pin", "置頂"] }),
  reg(discordUnpin, "match", "discord-messages", { keywords: ["取消釘選", "unpin", "取消置頂"] }),
  reg(discordCreateThread, "match", "discord-messages", { keywords: ["討論串", "thread", "開串"] }),
  reg(discordCreateForumPost, "match", "discord-messages", { keywords: ["論壇", "forum", "貼文", "發文"] }),
  reg(discordEditMessage, "match", "discord-messages", { keywords: ["編輯訊息", "edit message", "改訊息"] }),
  reg(discordArchiveThread, "match", "discord-messages", { keywords: ["封存", "archive", "討論串"] }),

  // ── match: google calendar (non-delete) ──
  reg(calendarListEvents, "match", "google-calendar", { keywords: ["行程", "日曆", "會議", "活動", "calendar", "event", "行事曆"], signals: ["hasDateTime"] }),
  reg(calendarCreateEvent, "match", "google-calendar", { keywords: ["建立行程", "新增活動", "calendar", "event", "加行程"] }),
  reg(calendarUpdateEvent, "match", "google-calendar", { keywords: ["改行程", "更新活動", "calendar", "event"] }),

  // ── match: gmail (non-delete) ──
  reg(gmailSearch, "match", "google-gmail", { keywords: ["信", "郵件", "email", "gmail", "查信", "收件匣"] }),
  reg(gmailRead, "match", "google-gmail", { keywords: ["讀信", "郵件內容", "email", "gmail"] }),
  reg(gmailSend, "match", "google-gmail", { keywords: ["寄信", "寄給", "send email", "gmail", "發信"] }),
  reg(gmailCreateDraft, "match", "google-gmail", { keywords: ["草稿", "draft", "email", "gmail"] }),

  // ── match: google drive ──
  reg(driveSearch, "match", "google-drive", { keywords: ["雲端", "drive", "文件搜尋", "檔案搜尋", "找檔案"] }),
  reg(driveRead, "match", "google-drive", { keywords: ["讀文件", "drive", "雲端內容", "讀雲端"] }),
  reg(driveUpload, "match", "google-drive", { keywords: ["上傳", "upload", "drive", "雲端", "存雲端"] }),

  // ── match: google tasks ──
  reg(tasksList, "match", "google-tasks", { keywords: ["待辦", "task", "任務清單", "tasks"] }),
  reg(tasksCreate, "match", "google-tasks", { keywords: ["新增待辦", "加任務", "task", "tasks"] }),
  reg(tasksComplete, "match", "google-tasks", { keywords: ["完成待辦", "完成任務", "task", "tasks"] }),

  // ── match: other explicit-intent ──
  reg(selfEvolve, "match", "self-development", { keywords: ["改 code", "改程式", "修程式", "實作", "self evolve", "source code", "自我修改", "改原始碼"], aliases: ["s-e", "self_evolve"] }),
  reg(imageGen, "match", "image-generation", { keywords: ["生成圖片", "生圖", "畫一張", "幫我畫", "繪圖", "插圖", "照片", "自拍", "image", "圖片", "去背", "移除背景"], signals: ["hasImageEditRequest"], modelPredicate: isGptModel }),
  reg(sessionSearch, "match", "history-journal", { keywords: ["搜尋對話", "歷史對話", "session search", "找對話", "以前說過"] }),
  reg(skillList, "match", "skills", { keywords: ["技能", "skill", "skill list", "列出技能"] }),
  reg(usageDashboard, "match", "usage", { keywords: ["用量", "usage", "儀表板", "dashboard", "統計", "花費"] }),

  // ── index: known-but-not-schema ──
  reg(sessionsByDate, "index", "history-journal"),
  reg(journalTranscriptByDate, "index", "history-journal"),
  reg(soulGuardianStatus, "index", "integrity"),
  reg(soulGuardianCheck, "index", "integrity"),
  reg(soulGuardianHistory, "index", "integrity"),
  reg(discordBotMentionToggle, "index", "discord-admin"),

  // ── on-demand: rare / destructive / irreversible ──
  reg(discordDeleteThread, "on-demand", "discord-admin"),
  reg(discordDeleteMessage, "on-demand", "discord-admin"),
  reg(calendarDeleteEvent, "on-demand", "google-calendar"),
  reg(tasksDelete, "on-demand", "google-tasks"),
  reg(soulGuardianApprove, "on-demand", "integrity"),
  reg(soulGuardianRestore, "on-demand", "integrity"),
  reg(skillInstall, "on-demand", "skills"),
  reg(skillUninstall, "on-demand", "skills"),
];

const CATALOG_NAME = "tool_catalog";

// tool_catalog is always native and is the unified discovery/proxy entry point.
// Injection avoids a circular import: the catalog factory receives executeTool and
// the registration list rather than importing this module.
const toolCatalog = createToolCatalog({
  listRegistrations: () => allRegistrations(),
  executeTool: (name, args) => executeTool(name, args),
  catalogName: CATALOG_NAME,
});

const registrations: ToolRegistration[] = [
  reg(toolCatalog, "native", "catalog"),
  ...baseRegistrations,
];

/**
 * Plugin-contributed registrations. Populated at runtime by `registerPluginTools()`
 * (called from the plugin loader after dynamic import). Kept in a SEPARATE mutable array
 * so the builtin `registrations` list — and its module-load validation — stay intact, and
 * so every consumer below can fold plugins in via `allRegistrations()`.
 */
const pluginRegistrations: ToolRegistration[] = [];

/** Names of plugin tools declared owner-only (the plugin default). Mirrors the builtin
 *  OWNER_ONLY_TOOLS set for plugin tools; consulted by `isOwnerOnly()`. */
const pluginOwnerOnly = new Set<string>();

/** Runtime availability for plugin tools. Tools that require a start hook remain hidden
 *  and uncallable until that hook succeeds. Names stay reserved even when unavailable. */
const pluginAvailability = new Map<string, boolean>();

/** Builtin registrations + plugin registrations. Single iteration source for selection,
 *  <tool-index> rendering, the catalog list and the legacy full tool list. */
function activePluginRegistrations(): ToolRegistration[] {
  return pluginRegistrations.filter(r => pluginAvailability.get(r.tool.name) === true);
}

function allRegistrations(): ToolRegistration[] {
  const activePlugins = activePluginRegistrations();
  return activePlugins.length ? [...registrations, ...activePlugins] : registrations;
}

/** True when a tool name is already registered (builtin OR plugin). Used by the plugin
 *  loader to enforce global name uniqueness before accepting a plugin. */
export function hasToolName(name: string): boolean {
  return registrationMap.has(name) || pluginRegistrations.some(r => r.tool.name === name);
}

/**
 * Register a batch of validated plugin tools. Called by the plugin loader. Re-checks
 * global name uniqueness (authoritative gate) and updates the executor / registration
 * maps plus the owner-only set. Throws on a duplicate so the loader can isolate that
 * plugin; it rejects the whole batch before mutating anything, so no partial registration.
 */
export function registerPluginTools(
  regs: PluginToolRegistration[],
  options: { active?: boolean } = {},
): void {
  const batchNames = new Set<string>();
  for (const r of regs) {
    if (hasToolName(r.tool.name) || batchNames.has(r.tool.name)) {
      throw new Error(`Duplicate plugin tool name: ${r.tool.name}`);
    }
    batchNames.add(r.tool.name);
  }
  for (const r of regs) {
    const registration: ToolRegistration = {
      tool: r.tool,
      exposure: r.exposure ?? "on-demand",
      group: r.group,
      keywords: r.keywords,
      aliases: r.aliases,
      signals: r.signals,
      modelPredicate: r.modelPredicate,
    };
    pluginRegistrations.push(registration);
    registrationMap.set(r.tool.name, registration);
    executorMap.set(r.tool.name, r.tool.execute);
    pluginAvailability.set(r.tool.name, options.active ?? true);
    // Plugin tools default to owner-only unless the author explicitly set ownerOnly:false.
    if (r.ownerOnly !== false) pluginOwnerOnly.add(r.tool.name);
  }
}


/** Activate or deactivate a previously registered plugin's tools as one lifecycle unit. */
export function setPluginToolsActive(names: string[], active: boolean): void {
  for (const name of names) {
    if (!pluginAvailability.has(name)) {
      throw new Error(`Unknown plugin tool: ${name}`);
    }
  }
  for (const name of names) pluginAvailability.set(name, active);
}

// ── Registration validation (runs once at module load) ──
(function validateRegistrations() {
  const seen = new Set<string>();
  for (const r of registrations) {
    const name = r.tool.name;
    if (seen.has(name)) throw new Error(`Duplicate tool registration: ${name}`);
    seen.add(name);
    const valid: ExposureLevel[] = ["native", "match", "index", "on-demand"];
    if (!valid.includes(r.exposure)) throw new Error(`Invalid exposure for ${name}: ${r.exposure}`);
    // match tools should carry at least one matching signal (keyword/alias) so the
    // matcher can ever reach them; otherwise they would only be reachable via catalog.
    if (r.exposure === "match" && (r.keywords?.length ?? 0) === 0 && (r.aliases?.length ?? 0) === 0) {
      logger.warn({ tool: name }, "match tool has no keywords/aliases; only reachable via tool_catalog");
    }
  }
})();

const executorMap = new Map(registrations.map(r => [r.tool.name, r.tool.execute]));
const registrationMap = new Map(registrations.map(r => [r.tool.name, r]));

/** Anthropic server-side tools — provider-owned, cannot be proxied by tool_catalog.
 *  First version keeps them directly exposed (native-provider). */
const SERVER_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 },
  { type: "code_execution_20250825", name: "code_execution" },
];

function toAnthropicTool(t: Tool) {
  return { name: t.name, description: t.description, input_schema: t.parameters };
}

/**
 * Legacy full tool list (exposure flag OFF). A function rather than a constant because
 * plugin registrations are added at runtime AFTER this module loads — a const captured at
 * load time would omit them. baseRegistrations excludes the exposure-only tool_catalog by
 * construction; plugin tools are folded in so the OFF path still exposes them.
 */
export function getAnthropicTools(): AnthropicToolDefinition[] {
  return [
    ...baseRegistrations.map(r => toAnthropicTool(r.tool)),
    ...activePluginRegistrations().map(r => toAnthropicTool(r.tool)),
    ...SERVER_TOOLS,
  ];
}

export interface ToolSelectionContext {
  model: string;
  /** Raw prompt/trigger text used for matching (may be empty). */
  prompt: string;
  trigger: string;
  /** Whether the request carried attachments. */
  hasAttachment?: boolean;
  /** Whether the exposure feature is enabled. */
  exposureEnabled: boolean;
  /** Cap on matched tools (native excluded). */
  maxMatchedTools: number;
  /** Tool names already surfaced this request (e.g. named or catalog-described). */
  enabledTools?: Set<string>;
}

interface AnthropicToolDefinition {
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
  max_uses?: number;
}

function passesModelGate(r: ToolRegistration, model: string): boolean {
  return r.modelPredicate ? r.modelPredicate(model) : true;
}

/**
 * Compute the tool definitions to send this turn.
 *
 * Feature flag OFF → identical to legacy: every local tool (minus GPT-only image_gen
 * for non-GPT) plus the 3 server tools.
 *
 * Feature flag ON:
 * - native always included (minus failed model gate);
 * - match included when the deterministic matcher hits this turn (or already enabled);
 * - index / on-demand omitted — reached through tool_catalog;
 * - server tools always included (native-provider).
 */
export function getToolDefinitions(ctx: ToolSelectionContext): AnthropicToolDefinition[] {
  if (!ctx.exposureEnabled) {
    const localTools = [...baseRegistrations, ...activePluginRegistrations()]
      .filter(r => passesModelGate(r, ctx.model))
      .map(r => toAnthropicTool(r.tool));
    return [...localTools, ...SERVER_TOOLS];
  }

  const out: AnthropicToolDefinition[] = [];
  const normalized = normalizeForMatch(ctx.prompt);
  const signals = detectSignals(ctx.prompt, ctx.hasAttachment ?? false);
  const all = allRegistrations();
  const matchRegs = all.filter(r => r.exposure === "match");
  const hits = matchTools(matchRegs, normalized, signals, ctx.maxMatchedTools);
  const hitNames = new Set(hits.map(h => h.name));
  const enabled = ctx.enabledTools ?? new Set<string>();

  const included: string[] = [];
  const matchedNames: string[] = [];
  for (const r of all) {
    const name = r.tool.name;
    if (!passesModelGate(r, ctx.model)) continue;

    let include = false;
    if (r.exposure === "native") include = true;
    else if (r.exposure === "match" && (hitNames.has(name) || enabled.has(name))) {
      include = true;
      if (hitNames.has(name)) matchedNames.push(name);
    } else if (enabled.has(name)) {
      // index/on-demand explicitly surfaced this request → allow direct schema.
      include = true;
    }

    if (include) {
      out.push(toAnthropicTool(r.tool));
      included.push(name);
    }
  }

  for (const s of SERVER_TOOLS) out.push(s);

  const jsonBytes = Buffer.byteLength(JSON.stringify(out), "utf8");
  logger.info(
    {
      exposure: "on",
      model: ctx.model,
      nativeCount: all.filter(r => r.exposure === "native" && passesModelGate(r, ctx.model)).length,
      matchedNames,
      toolCount: out.length,
      jsonBytes,
      promptLen: ctx.prompt.length,
    },
    "tool selection",
  );

  return out;
}

/**
 * Render the short <tool-index> block from registry metadata. Lists only `index`
 * groups (never on-demand, never native/match). Returns "" when there is nothing to
 * show (also used to skip the block when the feature flag is off — the caller decides).
 */
export function renderToolIndex(): string {
  const groups = new Set<string>();
  for (const r of allRegistrations()) {
    if (r.exposure === "index") groups.add(r.group);
  }
  if (groups.size === 0) return "";
  const labels = [...groups].map(g => GROUP_LABELS[g] ?? g).join(", ");
  return `<tool-index>
Additional tool groups are available through tool_catalog: ${labels}.
The tools listed directly are not the full capability set. When a tool you need is not directly exposed, use tool_catalog (search / describe / call) instead of assuming the capability is missing. Exposure controls visibility, not permission.
</tool-index>`;
}

/**
 * bash 是沒有沙箱的任意指令執行——開放給非 owner 等於把 shell 開給任何
 * 能 @ 到 bot 的人。預設鎖成 owner-only，要放寬得自己在 config 明示。
 */
function isOwnerOnly(name: string): boolean {
  if (name === "bash") {
    const { bash_owner_only, bash_allowed_users } = loadConfig().tools;
    if (!bash_owner_only) return false;
    // 例外人員：名單上的 user 也能用 bash（僅 bash，其他 owner-only 工具照擋）
    const userId = getUserId();
    return !(userId && bash_allowed_users.includes(userId));
  }
  return OWNER_ONLY_TOOLS.has(name) || pluginOwnerOnly.has(name);
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (isOwnerOnly(name) && getTrigger() === "discord-other") {
    logger.warn({ tool: name, trigger: getTrigger() }, "tool permission denied");
    return "⚠️ PERMISSION DENIED: This tool is owner-only. You are responding to a non-owner user. Do NOT attempt to use this tool again for this request.";
  }
  // Model-capability gate on the UNIFIED execution path. A tool's modelPredicate is a
  // real capability guard, not just schema visibility: without this check, tool_catalog
  // .call could proxy-execute a model-gated tool (e.g. GPT-only image_gen) on a model
  // that should not have it, since catalog bypasses the getToolDefinitions schema layer.
  // Enforcing it here covers both direct schema calls and catalog-proxied calls, and
  // does not break GPT's normal use (the predicate passes for GPT).
  const reg = registrationMap.get(name);
  if (pluginAvailability.has(name) && pluginAvailability.get(name) !== true) {
    logger.warn({ tool: name }, "plugin tool unavailable because startup did not complete");
    return `⚠️ TOOL UNAVAILABLE: ${name} is registered but its plugin did not start successfully.`;
  }
  if (reg?.modelPredicate) {
    // Use the request-scoped model (options.model ?? currentModel), bound in the ALS
    // request context by ask(). This reflects the model the request is actually running
    // on — not a global that a concurrent request could race — so tool_catalog.call
    // cannot bypass a per-request gate. Outside an ALS scope (e.g. a direct CLI tool
    // call) getRequestModel() is undefined; fall back to currentModel.
    const model = getRequestModel() ?? loadConfig().llm.currentModel;
    if (!reg.modelPredicate(model)) {
      logger.warn({ tool: name, model }, "tool model-capability denied");
      return `⚠️ CAPABILITY UNAVAILABLE: ${name} is not available with the active model (${model}). Do NOT retry via tool_catalog; this is a model limitation, not a permission you can escalate.`;
    }
  }
  const executor = executorMap.get(name);
  if (!executor) return `Unknown tool: ${name}`;
  const result = await executor(args);
  if (typeof result !== "string") {
    throw new TypeError(`Tool ${name} violated the tool contract: execute() must resolve to a string (received ${typeof result})`);
  }
  return result;
}

/** Look up a registration by tool name (used e.g. for progress display of proxied calls). */
export function getRegistration(name: string): ToolRegistration | undefined {
  return registrationMap.get(name);
}
