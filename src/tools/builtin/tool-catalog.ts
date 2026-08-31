import type { Tool } from "../../types.js";
import type { ToolRegistration } from "../metadata.js";
import { GROUP_LABELS } from "../metadata.js";

/**
 * Dependencies injected by the registry when it builds the catalog. Injection (rather
 * than importing registry.ts here) keeps this module free of a circular import: the
 * registry imports this factory, this factory never imports the registry back.
 */
export interface CatalogDeps {
  /** All tool registrations except the catalog itself. */
  listRegistrations: () => ToolRegistration[];
  /** The single, authoritative execution entry point. Enforces owner-only,
   *  bash allowlist, read_file guard, per-tool confirmation, etc. */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Name of the catalog tool itself, so `call` can refuse to recurse. */
  catalogName: string;
}

const MAX_SEARCH_RESULTS = 12;
const MAX_BATCH_QUERIES = 8;
const MAX_BATCH_RESULTS_PER_QUERY = 6;

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/[\s,，、]+/).map(t => t.trim()).filter(Boolean);
}

/** Score a registration against query tokens. Higher = more relevant. */
function scoreRegistration(reg: ToolRegistration, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystack = [
    reg.tool.name,
    reg.group,
    ...(reg.aliases ?? []),
    ...(reg.keywords ?? []),
    reg.tool.description.slice(0, 200),
  ]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (reg.tool.name.toLowerCase().includes(t)) score += 5;
    else if ((reg.aliases ?? []).some(a => a.toLowerCase().includes(t))) score += 4;
    else if (reg.group.toLowerCase().includes(t)) score += 3;
    else if (haystack.includes(t)) score += 1;
  }
  return score;
}

function searchRegistrations(regs: ToolRegistration[], query: string, limit = MAX_SEARCH_RESULTS): ToolRegistration[] {
  const tokens = tokenize(query);
  return regs
    .filter(r => r.exposure !== "native")
    .map(r => ({ reg: r, score: scoreRegistration(r, tokens) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.reg);
}

function formatSearchResult(query: string, matches: ToolRegistration[]): string {
  if (matches.length === 0) return `No tools matched "${query}".`;
  const lines = matches.map(reg => {
    const desc = reg.tool.description.replace(/\s+/g, " ").slice(0, 120);
    return `- ${reg.tool.name} [${reg.group}, ${reg.exposure}]: ${desc}`;
  });
  return `Tools matching "${query}":\n${lines.join("\n")}`;
}

function searchQueries(args: Record<string, unknown>): string[] | string {
  const single = typeof args.query === "string" ? args.query.trim() : "";
  const batch = Array.isArray(args.queries)
    ? args.queries.filter((q): q is string => typeof q === "string").map(q => q.trim()).filter(Boolean)
    : [];
  const queries = [...new Set([...(single ? [single] : []), ...batch])];
  if (queries.length === 0) return "search requires a non-empty 'query' or 'queries'.";
  if (queries.length > MAX_BATCH_QUERIES) return `search accepts at most ${MAX_BATCH_QUERIES} independent queries.`;
  return queries;
}

/**
 * Build the always-`native` tool_catalog tool. It is the unified discovery + proxy
 * entry point for any tool not directly exposed this turn.
 *
 * Security invariants (see plan §8):
 * - `call` always goes through the injected `executeTool()`; it never touches an
 *   executor map directly, so owner-only / bash allowlist / read_file guard /
 *   confirmation rules all still apply.
 * - `call` refuses to invoke the catalog itself (no recursion).
 * - unknown tool / permission denied / bad schema surface as plain strings.
 * - catalog output is untrusted metadata; it carries no user-controllable instructions.
 */
export function createToolCatalog(deps: CatalogDeps): Tool {
  return {
    name: "tool_catalog",
    description:
      "Discover and invoke tools that are not directly exposed this turn. The directly listed tools are NOT the full set of capabilities — when a tool you need is missing, use this instead of saying it does not exist. Exposure controls visibility, not permission: a tool found here still enforces its own owner-only and confirmation rules. Actions: list_groups (list capability groups), search (find tools by query, includes hidden ones), describe (show a tool's description + input schema), call (proxy-execute a tool by name with arguments).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list_groups", "search", "describe", "call"],
          description: "What to do.",
        },
        query: { type: "string", description: "For search: one keyword query (backward-compatible single-query form)." },
        queries: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_BATCH_QUERIES,
          description: "For search: multiple independent keyword queries evaluated separately in one call.",
        },
        tool_name: { type: "string", description: "For describe/call: the target tool name." },
        arguments: {
          type: "object",
          description: "For call: the arguments object passed to the target tool.",
        },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args.action ?? "").trim();
      const regs = deps.listRegistrations();

      if (action === "list_groups") {
        // Only surface index-visible groups (index + match). on-demand stays hidden here;
        // it is only findable via search.
        const groups = new Map<string, number>();
        for (const reg of regs) {
          if (reg.exposure === "native") continue;
          if (reg.exposure === "on-demand") continue;
          groups.set(reg.group, (groups.get(reg.group) ?? 0) + 1);
        }
        const lines = [...groups.entries()].map(
          ([g, n]) => `- ${g} (${GROUP_LABELS[g] ?? g}): ${n} tool(s)`,
        );
        return lines.length
          ? `Capability groups reachable via tool_catalog:\n${lines.join("\n")}\nUse action=search to find specific tools (search also covers rarer on-demand tools).`
          : "No additional capability groups are registered.";
      }

      if (action === "search") {
        const queries = searchQueries(args);
        if (typeof queries === "string") return queries;
        // Each query is scored independently. This preserves separate intent instead of
        // flattening unrelated capability searches into one noisy token bag.
        const perQueryLimit = queries.length === 1 ? MAX_SEARCH_RESULTS : MAX_BATCH_RESULTS_PER_QUERY;
        const blocks = queries.map(query => formatSearchResult(query, searchRegistrations(regs, query, perQueryLimit)));
        const body = queries.length === 1
          ? blocks[0]
          : `Batched tool search (${queries.length} independent queries):\n\n${blocks.join("\n\n")}`;
        return `${body}\nUse action=describe to see a tool's input schema, then action=call to run it.`;
      }

      if (action === "describe") {
        const toolName = String(args.tool_name ?? "").trim();
        if (!toolName) return "describe requires 'tool_name'.";
        const reg = regs.find(r => r.tool.name === toolName);
        if (!reg) return `Unknown tool: ${toolName}. Use action=search to find valid names.`;
        return JSON.stringify(
          {
            name: reg.tool.name,
            group: reg.group,
            exposure: reg.exposure,
            description: reg.tool.description,
            input_schema: reg.tool.parameters,
          },
          null,
          2,
        );
      }

      if (action === "call") {
        const toolName = String(args.tool_name ?? "").trim();
        if (!toolName) return "call requires 'tool_name'.";
        if (toolName === deps.catalogName) {
          return "tool_catalog cannot call itself.";
        }
        const reg = regs.find(r => r.tool.name === toolName);
        if (!reg) return `Unknown tool: ${toolName}. Use action=search to find valid names.`;
        const callArgs = (args.arguments && typeof args.arguments === "object")
          ? (args.arguments as Record<string, unknown>)
          : {};
        // Delegate to the ONE execution path. This preserves owner-only checks, the
        // bash allowlist, the read_file path guard, and every per-tool confirmation
        // rule. We never call reg.tool.execute directly.
        return deps.executeTool(toolName, callArgs);
      }

      return `Unknown action: ${action}. Valid actions: list_groups, search, describe, call.`;
    },
  };
}
