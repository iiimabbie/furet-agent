import type { AgentResponse, Tool } from "../types.js";
import type { ExposureLevel, MatchSignalName } from "./metadata.js";

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

/** Host capabilities passed to scheduled jobs and event handlers. */
export interface PluginRuntimeContext {
  /** Run an isolated agent request under the trusted `plugin` trigger. */
  ask: (prompt: string, options?: PluginAskOptions) => Promise<AgentResponse>;
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
  /** Optional so a plugin may contribute only background jobs or event handlers. */
  tools?: PluginToolRegistration[];
  /** Declarative background jobs registered automatically with the plugin lifecycle. */
  schedules?: PluginScheduleRegistration[];
  /** Event handlers invoked only after the corresponding core event succeeds. */
  events?: PluginEventRegistration[];
}

export interface PluginManifest {
  /** Unique plugin name; also namespaces schedules and diagnostics. */
  name: string;
  /** Called once before tools/jobs/events become active. */
  start?: () => Promise<void> | void;
  /** Called during graceful gateway shutdown. */
  stop?: () => Promise<void> | void;
}

export interface PluginRuntimeStatus {
  plugins: Array<{
    name: string;
    state: "loaded" | "started" | "failed";
    schedules: number;
    events: number;
  }>;
  activeSchedules: number;
  runningJobs: number;
}
