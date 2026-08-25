import type { Tool } from "../types.js";
import type { ExposureLevel, MatchSignalName } from "./metadata.js";

/**
 * Stable public API for private Furet plugins (extensions).
 *
 * A plugin is a local module (loaded from a path in `config.plugins`) that can register
 * extra tools WITHOUT editing `src/tools/registry.ts`. This keeps private integrations
 * (e.g. the private livly-mumu plugin) out of the repo while still going through the one
 * execution path — exposure grading, owner-only checks, model gates and the tool_catalog
 * proxy all apply to plugin tools exactly as they do to builtin tools.
 *
 * IMPORTANT invariants a plugin author must respect:
 * - Tool names are GLOBALLY unique. A plugin tool whose name collides with a builtin (or
 *   another plugin) is rejected and the whole plugin fails to load — no silent shadowing.
 * - Exposure is *visibility*, not permission. `ownerOnly` (default true) is the real gate,
 *   enforced by the registry's `executeTool()`; hiding a tool never grants it.
 * - `execute` returns `Promise<string>` (first-version tool result protocol). Rich results
 *   (e.g. same-turn image recognition for livly screenshots) are a future extension — see
 *   DESIGN.md › Plugin 系統 › 已知限制.
 */

/**
 * How a plugin classifies one tool it registers. Mirrors the fields the registry's
 * internal `ToolRegistration` carries, plus `ownerOnly` (which for builtins lives in the
 * hard-coded `OWNER_ONLY_TOOLS` set — plugins declare it inline instead).
 */
export interface PluginToolRegistration {
  /** The tool itself (`src/types.ts` `Tool`). `execute` must return `Promise<string>`. */
  tool: Tool;
  /**
   * Exposure level. Defaults to `"on-demand"` when omitted — a private plugin tool should
   * not leak into every prompt unless the author opts into `match` / `native`.
   */
  exposure?: ExposureLevel;
  /** Capability group; used for <tool-index> grouping and tool_catalog listing. */
  group: string;
  /** Chinese + English keywords that make a `match`-level tool match a prompt. */
  keywords?: string[];
  /** Alternate names/phrases; an exact mention counts as a direct match hit. */
  aliases?: string[];
  /** Optional coarse request signals used by match exposure. */
  signals?: MatchSignalName[];
  /** Optional model gate — same semantics as builtin `modelPredicate`. */
  modelPredicate?: (model: string) => boolean;
  /**
   * Owner-only enforcement. Plugin tools default to `true` (owner-only) because a private
   * integration typically exposes owner data/actions. Set `false` explicitly only when the
   * tool is safe for non-owner (`discord-other`) callers.
   */
  ownerOnly?: boolean;
}

/**
 * A plugin module's default export. The loader imports the module and reads `.default`
 * (or the module namespace itself if it directly matches this shape).
 */
export interface PluginModule {
  /** Manifest: at minimum a unique `name`; optional lifecycle hooks. */
  manifest: PluginManifest;
  /** The tools this plugin contributes. */
  tools: PluginToolRegistration[];
}

export interface PluginManifest {
  /** Human-readable plugin name; used only for logging/diagnostics (not a namespace). */
  name: string;
  /**
   * Optional startup hook. Called once by `startPlugins()` before background services
   * accept traffic. A throw here is logged and isolates to this plugin only.
   */
  start?: () => Promise<void> | void;
  /**
   * Optional shutdown hook. Called by `stopPlugins()` on gateway shutdown / SIGINT /
   * SIGTERM. A throw here is logged and does not block other plugins from stopping.
   */
  stop?: () => Promise<void> | void;
}
