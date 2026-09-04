import type { AgentResponse, Tool } from "../types.js";
import type { LlmCapability } from "../llm/types.js";
import type { ExposureLevel, MatchSignalName } from "./metadata.js";
import type { PluginConfigStore } from "../plugin-config.js";

/** Stable public API for private Furet plugins (extensions). */

export interface PluginToolRegistration {
  /** The tool itself (`src/types.ts` `Tool`). `execute` must return `Promise<string>`. */
  tool: Tool;
  /** Defaults to `"on-demand"`. */
  exposure?: ExposureLevel;
  /** Capability group used by the tool index and tool catalog. */
  group: string;
  keywords?: string[];
  aliases?: string[];
  signals?: MatchSignalName[];
  capability?: LlmCapability;
  modelPredicate?: (model: string) => boolean;
  /** Defaults to true. */
  ownerOnly?: boolean;
}

/** Options deliberately exposed to plugin-owned agent requests. */
export interface PluginAskOptions {
  systemPrompt?: string;
  maxTurns?: number;
  model?: string;
}

/** Text-only Discord transport available to trusted plugin workflows. */
export interface PluginMessageTransport {
  sendText: (input: { channelId: string; content: string }) => Promise<{ messageId: string }>;
  editText: (input: { channelId: string; messageId: string; content: string }) => Promise<{ messageId: string; migrated: boolean }>;
}

/** Host capabilities passed to plugin lifecycle hooks and callbacks. */
export interface PluginRuntimeContext {
  /** Run an isolated agent request under the trusted `plugin` trigger. */
  ask: (prompt: string, options?: PluginAskOptions) => Promise<AgentResponse>;
  /** Send or edit a text message without exposing the Discord client or raw interactions. */
  messages: PluginMessageTransport;
  /** Private YAML configuration at `workspace/config/plugins/<plugin>.yaml`. */
  config: PluginConfigStore;
}

export interface PluginScheduleRegistration {
  /** Unique within this plugin. Runtime identity becomes `<plugin name>:<id>`. */
  id: string;
  /** Human-readable diagnostics/status label. Defaults to `id`. */
  name?: string;
  /** Standard five-field cron expression. */
  schedule: string;
  /** Optional IANA timezone passed to node-cron. */
  timezone?: string;
  /** Warn when a run exceeds this duration. The callback is not force-cancelled. */
  timeoutMs?: number;
  /** Runs at most once concurrently; overlapping ticks are skipped. */
  run: (context: PluginRuntimeContext) => Promise<void> | void;
}

export type PluginSlashCommandOptionType = "string" | "integer" | "boolean" | "channel";

export interface PluginSlashCommandOption {
  name: string;
  description: string;
  type: PluginSlashCommandOptionType;
  required?: boolean;
  /** Static choices are supported for string and integer options. */
  choices?: Array<{ name: string; value: string | number }>;
}

export interface PluginSlashCommandContext {
  userId: string;
  channelId: string;
  guildId?: string;
  config: PluginConfigStore;
}

export interface PluginSlashCommandRegistration {
  /** Lowercase Discord command name. Must be globally unique. */
  name: string;
  description: string;
  options?: PluginSlashCommandOption[];
  /** Defaults to true. */
  ownerOnly?: boolean;
  /** Defaults to true so configuration commands do not clutter channels. */
  ephemeral?: boolean;
  execute: (
    args: Record<string, string | number | boolean | undefined>,
    context: PluginSlashCommandContext,
  ) => Promise<string> | string;
}

export type PluginEventName = "journal:completed";

export interface JournalCompletedEvent {
  event: "journal:completed";
  date: string;
  /** Final text returned by the built-in journal agent request. */
  result: string;
}

export type PluginEvent = JournalCompletedEvent;

export interface PluginJournalCompletedEventRegistration {
  event: "journal:completed";
  /** Unique within this plugin and event list. */
  id: string;
  timeoutMs?: number;
  run: (payload: JournalCompletedEvent, context: PluginRuntimeContext) => Promise<void> | void;
}

export type PluginEventRegistration = PluginJournalCompletedEventRegistration;

/** A plugin module's default export (or equivalent named exports). */
export interface PluginModule {
  manifest: PluginManifest;
  /** Optional so a plugin may contribute only background jobs, commands, or event handlers. */
  tools?: PluginToolRegistration[];
  /** Declarative background jobs registered automatically with the plugin lifecycle. */
  schedules?: PluginScheduleRegistration[];
  /** Discord slash commands registered by the host after the plugin starts. */
  commands?: PluginSlashCommandRegistration[];
  /** Event handlers invoked only after the corresponding core event succeeds. */
  events?: PluginEventRegistration[];
}

export interface PluginManifest {
  /** Unique plugin name; also namespaces schedules, config, and diagnostics. */
  name: string;
  /** Called once before tools/jobs/commands/events become active. */
  start?: (context: PluginRuntimeContext) => Promise<void> | void;
  /** Called during graceful gateway shutdown. */
  stop?: (context: PluginRuntimeContext) => Promise<void> | void;
}

export interface PluginRuntimeStatus {
  plugins: Array<{
    name: string;
    state: "loaded" | "started" | "failed";
    schedules: number;
    commands: number;
    events: number;
  }>;
  activeSchedules: number;
  runningJobs: number;
}
