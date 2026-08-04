import { logger } from "../../logger.js";
import { getDb } from "../../db.js";
import { toSearchQuery, highlightMatches } from "../../utils/cjk.js";
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

    // FTS 表存的是 bigram 展開後的 token（unicode61 不斷中文），所以查詢也要展開，
    // 顯示則用 session_archive 的原文。
    const ftsQuery = toSearchQuery(query);
    if (!ftsQuery) return "No matching sessions found.";

    try {
      const db = getDb();
      const results = db.prepare(`
        SELECT sa.session_id, sa.role, sa.content, sa.time, sa.msg_id
        FROM session_fts sf
        JOIN session_archive sa ON sa.id = sf.rowid
        WHERE session_fts MATCH ?
        ORDER BY sf.rank
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{
        session_id: string;
        role: string;
        content: string;
        time: string | null;
        msg_id: string | null;
      }>;

      if (results.length === 0) return "No matching sessions found.";

      const formatted = results.map(r => {
        const time = r.time ? `[${r.time}]` : "";
        return `[${r.session_id}] ${time} ${r.role}: ${highlightMatches(r.content, query)}`;
      });

      return `Found ${results.length} results:\n${formatted.join("\n")}`;
    } catch (err) {
      logger.error({ err: (err as Error).message }, "session search failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};
