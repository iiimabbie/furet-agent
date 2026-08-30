import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../../logger.js";
import { loadConfig } from "../../config.js";
import { getDb } from "../../db.js";
import { MEMORY_DIR, MEMORY_INDEX } from "../../paths.js";
import { addVector, searchVectors } from "../../embedding.js";
import { toSearchQuery, highlightMatches } from "../../utils/cjk.js";
import { today, clockTime } from "../../utils/time.js";
import { appendInsideTag, stripTag } from "../../utils/tagged-file.js";
import type { Tool } from "../../types.js";


export const memorySave: Tool = {
  name: "memory_save",
  description: "Append an event or conversation note to today's daily memory file (workspace/memory/yyyy-MM-dd.md) for diary continuity. This is not the canonical store for owner or people profiles and does not replace updating OWNER.md, PEOPLE.md, or long-term MEMORY.md when appropriate.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "The memory content to save" },
    },
    required: ["content"],
  },
  execute: async (args) => {
    const { content } = args as { content: string };
    const date = today();
    const filePath = resolve(MEMORY_DIR, `${date}.md`);
    logger.info({ date, content: content.slice(0, 100) }, "memory save");

    try {
      mkdirSync(MEMORY_DIR, { recursive: true });
      let existing = "";
      try { existing = readFileSync(filePath, "utf-8"); } catch { /* new file */ }

      const timestamp = clockTime();
      const entry = `\n- [${timestamp}] ${content}`;
      writeFileSync(filePath, existing + entry + "\n");

      // 同時存向量索引（背景執行，不阻塞回應）
      addVector(content, `${date}.md`).catch(() => {});

      return `Memory saved to ${date}.md`;
    } catch (err) {
      logger.error({ err }, "memory save failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const memorySearch: Tool = {
  name: "memory_search",
  description: "Semantic search over your own memory notes — what you concluded and wrote down. Use it when the user refers to something from before and you need the substance rather than the wording. To find the actual conversation it came from, use session_search; it searches transcripts, this one does not.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (supports semantic/meaning-based search)" },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const { query } = args as { query: string };
    logger.info({ query }, "memory search");

    try {
      const results: string[] = [];

      // 語意搜尋（向量，sqlite-vec）
      const vectorResults = await searchVectors(query);
      if (vectorResults.length > 0) {
        results.push("## Semantic matches\n" + vectorResults.map(r =>
          `- [${r.file}] (score: ${r.score.toFixed(2)}) ${r.text}`
        ).join("\n"));
      }

      // 全文搜尋（SQLite FTS5）。
      // FTS 表存的是 bigram 展開後的 token（中文不斷詞問題），所以查詢也要展開，
      // 顯示則用 memory_vectors 的原文。
      const ftsQuery = toSearchQuery(query);
      if (ftsQuery) {
        try {
          const db = getDb();
          const ftsResults = db.prepare(`
            SELECT mv.text, mv.file
            FROM memory_fts f
            JOIN memory_vectors mv ON mv.id = f.rowid
            WHERE memory_fts MATCH ?
            ORDER BY rank
            LIMIT 20
          `).all(ftsQuery) as Array<{ text: string; file: string }>;

          if (ftsResults.length > 0) {
            results.push("## Full-text matches\n" + ftsResults.map(r =>
              `- [${r.file}] ${highlightMatches(r.text, query)}`
            ).join("\n"));
          }
        } catch (err) {
          logger.warn({ err: (err as Error).message, query }, "memory FTS query failed");
        }
      }

      return results.length > 0 ? results.join("\n\n") : "No matching memories found.";
    } catch (err) {
      logger.error({ err }, "memory search failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const memoryList: Tool = {
  name: "memory_list",
  description: "List all memory files with dates.",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    try {
      mkdirSync(MEMORY_DIR, { recursive: true });
      const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md")).sort().reverse();

      let indexExists = false;
      try { readFileSync(MEMORY_INDEX); indexExists = true; } catch { /* */ }

      const lines = [];
      if (indexExists) lines.push("- MEMORY.md (long-term index)");
      for (const f of files) lines.push(`- memory/${f}`);
      return lines.length > 0 ? lines.join("\n") : "No memories yet.";
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

const MEMORY_TAG = "memory";

function readMemoryIndex(): string {
  try { return readFileSync(MEMORY_INDEX, "utf-8"); } catch { return ""; }
}


function memoryUsageInfo(content: string): string {
  const { memoryCharLimit } = loadConfig().llm;
  // 只算標籤內的實質內容，<memory> 包裝本身不該吃掉額度
  const len = stripTag(content, MEMORY_TAG).length;
  const pct = Math.round((len / memoryCharLimit) * 100);
  return `[${len}/${memoryCharLimit} chars, ${pct}%]`;
}

export const memoryAdd: Tool = {
  name: "memory_add",
  description: "Append new long-lived operating context to MEMORY.md: rules, preferences, recurring workflows, ongoing plans, or durable world facts that are not owner/people profile data. Use only when no matching section exists; otherwise use memory_replace.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "New content to append (e.g. a new section or bullet entry)" },
    },
    required: ["content"],
  },
  execute: async (args) => {
    const { content } = args as { content: string };
    logger.info({ content: content.slice(0, 80) }, "memory add");
    try {
      const current = readMemoryIndex();
      // 一定要接在 </memory> 裡面——直接往檔案尾端接的話，新條目會落到標籤外
      const updated = appendInsideTag(current, content, MEMORY_TAG);
      const { memoryCharLimit } = loadConfig().llm;
      if (updated.length > memoryCharLimit) {
        return `Error: would exceed character limit. ${memoryUsageInfo(current)} — consolidate existing entries first with memory_replace or memory_remove.`;
      }
      writeFileSync(MEMORY_INDEX, updated);
      return `Added. ${memoryUsageInfo(updated)}`;
    } catch (err) {
      logger.error({ err }, "memory add failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const memoryReplace: Tool = {
  name: "memory_replace",
  description: "Replace text in MEMORY.md to update or consolidate long-lived operating context. Do not use it for owner or other-person profile facts; those belong in OWNER.md or PEOPLE.md. MEMORY.md is already in your system prompt — no need to read it first.",
  parameters: {
    type: "object",
    properties: {
      old_text: { type: "string", description: "The existing text to find (substring match)" },
      new_text: { type: "string", description: "The replacement text" },
    },
    required: ["old_text", "new_text"],
  },
  execute: async (args) => {
    const { old_text, new_text } = args as { old_text: string; new_text: string };
    logger.info({ old: old_text.slice(0, 80), new: new_text.slice(0, 80) }, "memory replace");
    try {
      const current = readMemoryIndex();
      if (!current.includes(old_text)) {
        return `Error: old_text not found in MEMORY.md. Use memory_add to create new entries.`;
      }
      const updated = current.replace(old_text, new_text);
      const { memoryCharLimit } = loadConfig().llm;
      if (updated.length > memoryCharLimit) {
        return `Error: replacement would exceed limit. ${memoryUsageInfo(current)}`;
      }
      writeFileSync(MEMORY_INDEX, updated);
      return `Replaced. ${memoryUsageInfo(updated)}`;
    } catch (err) {
      logger.error({ err }, "memory replace failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const memoryRemove: Tool = {
  name: "memory_remove",
  description: "Remove outdated, duplicate, or misclassified text from MEMORY.md. Owner and other-person profile facts should be removed from MEMORY.md after their canonical files are updated.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to find and remove (substring match)" },
    },
    required: ["text"],
  },
  execute: async (args) => {
    const { text } = args as { text: string };
    logger.info({ text: text.slice(0, 100) }, "memory remove");
    try {
      const current = readMemoryIndex();
      if (!current.includes(text)) {
        return `Error: text not found in MEMORY.md.`;
      }
      const updated = current.replace(text, "").replace(/\n{3,}/g, "\n\n");
      writeFileSync(MEMORY_INDEX, updated);
      return `Removed. ${memoryUsageInfo(updated)}`;
    } catch (err) {
      logger.error({ err }, "memory remove failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};
