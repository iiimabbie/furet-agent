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

export const sessionsByDate: Tool = {
  name: "sessions_by_date",
  description: "Return the full raw conversation of all archived sessions for a given date (YYYY-MM-DD), in chronological order and grouped by session. Use this to reconstruct what happened on a day from first-hand messages — e.g. when writing the daily journal — instead of relying on summarized notes.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "Date to fetch, in YYYY-MM-DD format" },
    },
    required: ["date"],
  },
  execute: async (args) => {
    const { date } = args as { date: string };
    logger.info({ date }, "sessions by date");

    // session_archive.time 存的是 "MM/DD HH:mm"（無年份），用 MM/DD 前綴撈當天
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return `Error: date must be YYYY-MM-DD, got "${date}".`;
    const timePrefix = `${m[1]}/${m[2]}`; // MM/DD

    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT session_id, role, content, time
        FROM session_archive
        WHERE time LIKE ?
        ORDER BY session_id, id
      `).all(`${timePrefix}%`) as Array<{
        session_id: string;
        role: string;
        content: string;
        time: string | null;
      }>;

      if (rows.length === 0) return `No archived sessions found for ${date}.`;

      // 依 session 分組，組內維持時序
      const bySession = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = bySession.get(r.session_id) ?? [];
        list.push(r);
        bySession.set(r.session_id, list);
      }

      const blocks: string[] = [];
      for (const [sid, list] of bySession) {
        const lines = list.map(r => {
          const time = r.time ? `[${r.time}] ` : "";
          return `${time}${r.role}: ${r.content}`;
        });
        blocks.push(`=== session: ${sid} (${list.length} msgs) ===\n${lines.join("\n")}`);
      }

      return `${rows.length} messages across ${bySession.size} session(s) on ${date}:\n\n${blocks.join("\n\n")}`;
    } catch (err) {
      logger.error({ err: (err as Error).message }, "sessions by date failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};
