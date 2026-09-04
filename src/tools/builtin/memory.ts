import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../../logger.js";
import { loadConfig } from "../../config.js";
import { MEMORY_DIR, MEMORY_INDEX } from "../../paths.js";
import { searchUnified } from "../../search-index.js";
import { getChannelId, getSessionId, getTrigger, getUserId } from "../context.js";
import { hasOwnerSearchVisibility } from "../authz.js";
import { indexDiaryNote, reindexMemory } from "../../workspace-index.js";
import { today, clockTime } from "../../utils/time.js";
import { appendInsideTag, stripTag } from "../../utils/tagged-file.js";
import type { Tool } from "../../types.js";
import { updateSearchProjection, withProjectionNotice } from "../../utils/search-projection.js";
import { renderSearchOutput, truncateSearchText } from "../../utils/search-output.js";


export const diaryNote: Tool = {
  name: "diary_note",
  description: "Append a diary annotation to today's file (workspace/memory/yyyy-MM-dd.md). Use it for what the transcript cannot preserve: your own reactions, feelings, opinions, doubts and second thoughts; background nobody said out loud; cross-day connections; attachment or tool context needed to understand the day later. Do NOT re-log events or dialogue the transcript already holds. When writing about another person's inner state, do not assert it as fact — quote what they said or did, or mark it as your impression. Your own inner state is yours to state plainly.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "Diary context the transcript cannot preserve: your own perspective on the day, unspoken background, or cross-day links" },
    },
    required: ["content"],
  },
  execute: async (args) => {
    const { content } = args as { content: string };
    const date = today();
    const filePath = resolve(MEMORY_DIR, `${date}.md`);
    logger.info({ date, content: content.slice(0, 100) }, "diary note");

    try {
      mkdirSync(MEMORY_DIR, { recursive: true });
      let existing = "";
      try { existing = readFileSync(filePath, "utf-8"); } catch { /* new file */ }

      const timestamp = clockTime();
      const entry = `\n- [${timestamp}] ${content}`;
      writeFileSync(filePath, existing + entry + "\n");

      const projectionError = updateSearchProjection("diary note", () => indexDiaryNote(date, timestamp, content));
      return withProjectionNotice(`Note saved to ${date}.md.`, projectionError);
    } catch (err) {
      logger.error({ err }, "diary note failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const memorySearch: Tool = {
  name: "memory_search",
  description: "Permission-aware hybrid search across durable memory, people, diaries, prior conversations, tool evidence, and attachments. Use it when you need the substance of something from before; results include their real source and time.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language or exact-keyword search query" },
      limit: { type: "number", description: "Maximum results (default 10, max 50)" },
      debug: { type: "boolean", description: "Include search trace diagnostics (default false)" },
    },
    required: ["query"],
  },
  execute: async (args) => {
    const { query, limit = 10, debug = false } = args as { query: string; limit?: number; debug?: boolean };
    logger.info({ query, limit, debug }, "memory search");
    try {
      const response = await searchUnified(query, {
        profile: "memory",
        limit: Math.min(Math.max(Math.floor(limit), 1), 50),
        visibility: {
          isOwner: hasOwnerSearchVisibility(getTrigger()),
          userId: getUserId(),
          channelId: getChannelId(),
        },
        includeContext: true,
        debug,
      });
      if (response.results.length === 0) return "No matching memories found.";
      const lines = response.results.map(result => {
        const where = [result.sourceType, result.sourceId, result.occurredAt].filter(Boolean).join(" · ");
        const methods = result.matchedBy.join("+");
        const context = result.context?.length
          ? `\n  Context: ${truncateSearchText(result.context.map(item => `${item.role ?? "message"}: ${item.text}`).join(" | "), 900)}`
          : "";
        return `- [${where}] (${methods}, rank ${(result.score * 100).toFixed(0)}) ${truncateSearchText(result.text, 1800)}${context}`;
      });
      const diagnostics = debug
        ? `\n\nTrace ${response.traceId}: ${JSON.stringify(response.diagnostics)}`
        : "";
      return renderSearchOutput(`Search results (${response.results.length}):`, lines, diagnostics);
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
      const projectionError = updateSearchProjection("MEMORY.md", () => reindexMemory(updated));
      return withProjectionNotice(`Added. ${memoryUsageInfo(updated)}`, projectionError);
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
      const projectionError = updateSearchProjection("MEMORY.md", () => reindexMemory(updated));
      return withProjectionNotice(`Replaced. ${memoryUsageInfo(updated)}`, projectionError);
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
      const projectionError = updateSearchProjection("MEMORY.md", () => reindexMemory(updated));
      return withProjectionNotice(`Removed. ${memoryUsageInfo(updated)}`, projectionError);
    } catch (err) {
      logger.error({ err }, "memory remove failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};
