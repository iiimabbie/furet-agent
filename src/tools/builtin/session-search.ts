import { logger } from "../../logger.js";
import { getDb } from "../../db.js";
import type { Tool } from "../../types.js";

export const sessionSearch: Tool = {
  name: "session_search",
  description: "Search across archived session history using full-text search. Use this to find past conversations, decisions, or events from previous sessions.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (supports FTS5 syntax: AND, OR, NOT, phrases)" },
      limit: { type: "number", description: "Max results to return (default 20)" },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const { query, limit = 20 } = args as { query: string; limit?: number };
    logger.info({ query, limit }, "session search");

    try {
      const db = getDb();
      const results = db.prepare(`
        SELECT sa.session_id, sa.role, sa.content, sa.time, sa.msg_id,
               highlight(session_fts, 0, '**', '**') AS highlighted
        FROM session_fts sf
        JOIN session_archive sa ON sa.id = sf.rowid
        WHERE session_fts MATCH ?
        ORDER BY sf.rank
        LIMIT ?
      `).all(query, limit) as Array<{
        session_id: string;
        role: string;
        content: string;
        time: string | null;
        msg_id: string | null;
        highlighted: string;
      }>;

      if (results.length === 0) return "No matching sessions found.";

      const formatted = results.map(r => {
        const time = r.time ? `[${r.time}]` : "";
        return `[${r.session_id}] ${time} ${r.role}: ${r.highlighted}`;
      });

      return `Found ${results.length} results:\n${formatted.join("\n")}`;
    } catch (err) {
      logger.error({ err: (err as Error).message }, "session search failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};
