import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../../logger.js";
import { loadConfig } from "../../config.js";
import { MEMORY_DIR, MEMORY_INDEX } from "../../paths.js";
import { addVector, searchVectors } from "../../embedding.js";
import type { Tool } from "../../types.js";

function today(): string {
  return new Date().toISOString().split("T")[0];
}

export const memorySave: Tool = {
  name: "memory_save",
  description: "Save a memory. Appends to today's memory file (workspace/memory/yyyy-MM-dd.md). Use this to remember user preferences, facts, decisions, or anything worth recalling in future conversations.",
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

      const timestamp = new Date().toLocaleTimeString("zh-TW", { hour12: false });
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
  description: "Search across all memory files using semantic search. Use this when the user asks about something that might have been mentioned before, or when you need context from past conversations.",
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

      // 語意搜尋（向量）
      const vectorResults = await searchVectors(query);
      if (vectorResults.length > 0) {
        results.push("## Semantic matches\n" + vectorResults.map(r =>
          `- [${r.file}] (score: ${r.score.toFixed(2)}) ${r.text}`
        ).join("\n"));
      }

      // 關鍵字搜尋（fallback + 補充）
      mkdirSync(MEMORY_DIR, { recursive: true });
      const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md")).sort().reverse();
      const q = query.toLowerCase();
      const keywordResults: string[] = [];

      try {
        const index = readFileSync(MEMORY_INDEX, "utf-8");
        const lines = index.split("\n").filter(l => l.toLowerCase().includes(q));
        if (lines.length > 0) keywordResults.push(`[MEMORY.md]\n${lines.join("\n")}`);
      } catch { /* no index yet */ }

      for (const file of files.slice(0, 30)) {
        const content = readFileSync(resolve(MEMORY_DIR, file), "utf-8");
        const lines = content.split("\n").filter(l => l.toLowerCase().includes(q));
        if (lines.length > 0) keywordResults.push(`[${file}]\n${lines.join("\n")}`);
      }

      if (keywordResults.length > 0) {
        results.push("## Keyword matches\n" + keywordResults.join("\n\n"));
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

function readMemoryIndex(): string {
  try { return readFileSync(MEMORY_INDEX, "utf-8"); } catch { return ""; }
}

function memoryUsageInfo(content: string): string {
  const { memoryCharLimit } = loadConfig().llm;
  const pct = Math.round((content.length / memoryCharLimit) * 100);
  return `[${content.length}/${memoryCharLimit} chars, ${pct}%]`;
}

export const memoryReplace: Tool = {
  name: "memory_replace",
  description: "Replace text in long-term memory (MEMORY.md). Finds old_text by substring match and replaces with new_text. Use to update facts, add new entries to existing sections (replace the section content with an expanded version), or consolidate entries. MEMORY.md is already in your system prompt — no need to read it first.",
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
  description: "Remove text from long-term memory (MEMORY.md). Finds and deletes the matching text. Use to clean up outdated or duplicate entries.",
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
