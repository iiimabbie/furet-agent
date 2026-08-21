import { logger } from "../../logger.js";
import { getDb } from "../../db.js";
import { toSearchQuery, highlightMatches } from "../../utils/cjk.js";
import type { ContentBlock, Tool } from "../../types.js";

interface ArchivedSessionRow {
  session_id: string;
  role: string;
  content: string;
  time: string | null;
  msg_id?: string | null;
}

function dateToTimePrefix(date: string): string | null {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Extract the human-readable text from an archived message.
 *
 * Archive rows keep the original content blocks for forensic replay/search.  Journal
 * generation only needs speech, so tool calls, tool results, thinking, and other
 * structured blocks are intentionally discarded here.
 */
function extractTextContent(content: string): string {
  if (!content.startsWith("[")) return content;

  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return content;
    return (parsed as ContentBlock[])
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block?.type === "text")
      .map(block => block.text)
      .filter(Boolean)
      .join("\n");
  } catch {
    // A user can legitimately write text starting with `[`. It is not a content
    // block unless it parses as an array, so preserve it verbatim.
    return content;
  }
}

/** Harness/session bookkeeping is useful for debugging but is not dialogue. */
function isJournalNoise(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("[System] Tools actually executed")
    || trimmed.startsWith("[System] Session ending")
    || trimmed.startsWith("[System] Previous conversation summary")
    || trimmed.startsWith("[System] The following messages were proactively pushed")
    || /^\[System\] (Scheduled task|Reminder) .+ pushed the following message proactively/.test(trimmed);
}

/** Drop transport-only Discord metadata while retaining the speaker label and message. */
function stripTransportMetadata(text: string): string {
  return text.replace(/^\[msg:\S+\s[^\]]*\]\s*/, "").trim();
}

/**
 * Produce the journal-safe projection of archived session rows.
 * Exported for unit tests; raw archive data remains unchanged in SQLite and JSON.
 */
export function formatJournalTranscript(rows: ArchivedSessionRow[]): string {
  const bySession = new Map<string, Array<{ role: string; content: string }>>();

  for (const row of rows) {
    const content = stripTransportMetadata(extractTextContent(row.content));
    if (!content || isJournalNoise(content)) continue;

    const list = bySession.get(row.session_id) ?? [];
    list.push({ role: row.role, content });
    bySession.set(row.session_id, list);
  }

  if (bySession.size === 0) return "No journal-worthy conversation found.";

  const blocks: string[] = [];
  let messageCount = 0;
  for (const [sessionId, messages] of bySession) {
    messageCount += messages.length;
    const lines = messages.map(message => `${message.role}: ${message.content}`);
    blocks.push(`=== session: ${sessionId} (${messages.length} conversation messages) ===\n${lines.join("\n")}`);
  }

  return `${messageCount} clean conversation messages across ${bySession.size} session(s):\n\n${blocks.join("\n\n")}`;
}

export const sessionSearch: Tool = {
  name: "session_search",
  description: "Full-text search over archived conversations — the literal words people said. Only archived sessions are indexed: the current session and anything said today are not in here yet, so finding nothing means it is not in the archive — never that it did not happen. Use it to find when something was discussed or decided. For what you concluded and wrote down about a topic use memory_search instead (that one is semantic and searches your notes, not the transcript); to read a whole day end to end use sessions_by_date.",
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
      `).all(ftsQuery, limit) as ArchivedSessionRow[];

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
  description: "Return the full raw archived conversation for a date (YYYY-MM-DD), including harness and structured tool-call records. Use only for debugging/forensics; daily journals should use journal_transcript_by_date instead.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "Date in YYYY-MM-DD format" },
    },
    required: ["date"],
  },
  execute: async (args) => {
    const { date } = args as { date: string };
    logger.info({ date }, "sessions by date");

    const timePrefix = dateToTimePrefix(date);
    if (!timePrefix) return `Error: date must be YYYY-MM-DD, got "${date}".`;

    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT session_id, role, content, time
        FROM session_archive
        WHERE time LIKE ?
        ORDER BY session_id, id
      `).all(`${timePrefix}%`) as ArchivedSessionRow[];

      if (rows.length === 0) return `No archived sessions found for ${date}.`;

      const bySession = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = bySession.get(row.session_id) ?? [];
        list.push(row);
        bySession.set(row.session_id, list);
      }

      const blocks: string[] = [];
      for (const [sessionId, list] of bySession) {
        const lines = list.map(row => {
          const time = row.time ? `[${row.time}] ` : "";
          return `${time}${row.role}: ${row.content}`;
        });
        blocks.push(`=== session: ${sessionId} (${list.length} msgs) ===\n${lines.join("\n")}`);
      }

      return `${rows.length} messages across ${bySession.size} session(s) on ${date}:\n\n${blocks.join("\n\n")}`;
    } catch (err) {
      logger.error({ err: (err as Error).message }, "sessions by date failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const journalTranscriptByDate: Tool = {
  name: "journal_transcript_by_date",
  description: "Return a clean, journal-ready conversation transcript for an archived date (YYYY-MM-DD). Keeps human/user messages and assistant text, while removing tool calls, tool results, harness bookkeeping, system flush prompts, and transport timestamps. Use this for the daily journal instead of sessions_by_date.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "Date in YYYY-MM-DD format" },
    },
    required: ["date"],
  },
  execute: async (args) => {
    const { date } = args as { date: string };
    logger.info({ date }, "journal transcript by date");

    const timePrefix = dateToTimePrefix(date);
    if (!timePrefix) return `Error: date must be YYYY-MM-DD, got "${date}".`;

    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT session_id, role, content, time
        FROM session_archive
        WHERE time LIKE ?
        ORDER BY session_id, id
      `).all(`${timePrefix}%`) as ArchivedSessionRow[];

      if (rows.length === 0) return `No archived sessions found for ${date}.`;
      return formatJournalTranscript(rows);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "journal transcript by date failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};
