import { readFileSync, writeFileSync } from "node:fs";
import { logger } from "../../logger.js";
import { PEOPLE_FILE } from "../../paths.js";
import { addVector, removeVectorsByFile } from "../../embedding.js";
import type { Tool } from "../../types.js";

/**
 * PEOPLE.md 的編輯工具，與 memory_* 同構。
 *
 * 存在的理由：用 write_file 整份覆寫 PEOPLE.md 很容易弄丟 `<people>` 包裝標籤
 * （實際發生過），而且 agent 得先讀全文再重組，成本高又容易改壞既有條目。
 * 這裡改成 substring 操作，只動要改的段落。
 */

const OPEN_TAG = "<people>";
const CLOSE_TAG = "</people>";

function readPeople(): string {
  try { return readFileSync(PEOPLE_FILE, "utf-8"); } catch { return ""; }
}

/**
 * 寫回時確保 `<people>` 包裝還在——這是 system prompt 的區塊邊界，
 * 掉了會讓人物資料跟前後文糊在一起。
 */
function writePeople(content: string): void {
  let out = content.trim();
  if (!out.includes(OPEN_TAG)) out = `${OPEN_TAG}\n\n${out}`;
  if (!out.includes(CLOSE_TAG)) out = `${out}\n\n${CLOSE_TAG}`;
  writeFileSync(PEOPLE_FILE, out + "\n");
  reindexVectors(out);
}

/** 比照 write_file 的作法：整份重建向量，讓語意搜尋跟得上 */
function reindexVectors(content: string): void {
  try {
    removeVectorsByFile("PEOPLE.md");
    for (const p of content.split(/\n{2,}/)) {
      const t = p.trim();
      if (t.length > 20 && !t.startsWith(OPEN_TAG) && !t.startsWith(CLOSE_TAG)) {
        addVector(t, "PEOPLE.md").catch(() => {});
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "PEOPLE.md reindex failed");
  }
}

/** 去掉包裝標籤後的內容，用來判斷是不是空的 */
function bodyOf(content: string): string {
  return content.replace(OPEN_TAG, "").replace(CLOSE_TAG, "").trim();
}

export const peopleAdd: Tool = {
  name: "people_add",
  description: "Add a NEW person to PEOPLE.md. Use this the first time you encounter someone in a channel — record their Discord ID, how they talk, and anything that helps you address them correctly later. To update someone already listed, use people_update instead.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The new person's section, e.g. \"## Name\\n- **Discord ID**: 123\\n- **個性**: ...\". Use a `##` heading with their display name.",
      },
    },
    required: ["content"],
  },
  execute: async (args) => {
    const { content } = args as { content: string };
    logger.info({ content: content.slice(0, 80) }, "people add");
    try {
      const current = readPeople();
      const entry = content.trim();

      // 已經有這個人就擋下來，避免重複條目越積越多
      const heading = entry.split("\n")[0].replace(/^#+\s*/, "").trim();
      if (heading && bodyOf(current).includes(heading)) {
        return `Error: "${heading}" already exists in PEOPLE.md. Use people_update to modify the existing entry.`;
      }

      const body = bodyOf(current) || "# People";
      writePeople(`${body}\n\n${entry}`);
      return `Added to PEOPLE.md. [${bodyOf(readPeople()).length} chars]`;
    } catch (err) {
      logger.error({ err }, "people add failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const peopleUpdate: Tool = {
  name: "people_update",
  description: "Update an existing entry in PEOPLE.md by substring match. Use when you learn something new about someone already listed — a nickname, a preference, how they want to be addressed, a correction.",
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
    logger.info({ old: old_text.slice(0, 60), new: new_text.slice(0, 60) }, "people update");
    try {
      const current = readPeople();
      if (!current.includes(old_text)) {
        return `Error: old_text not found in PEOPLE.md. Use people_add for someone not listed yet.`;
      }
      writePeople(current.replace(old_text, new_text));
      return `Updated PEOPLE.md. [${bodyOf(readPeople()).length} chars]`;
    } catch (err) {
      logger.error({ err }, "people update failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const peopleRemove: Tool = {
  name: "people_remove",
  description: "Remove text from PEOPLE.md by substring match. Use to delete an outdated entry or a duplicate.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to find and remove (substring match)" },
    },
    required: ["text"],
  },
  execute: async (args) => {
    const { text } = args as { text: string };
    logger.info({ text: text.slice(0, 80) }, "people remove");
    try {
      const current = readPeople();
      if (!current.includes(text)) return `Error: text not found in PEOPLE.md.`;
      writePeople(current.replace(text, "").replace(/\n{3,}/g, "\n\n"));
      return `Removed from PEOPLE.md. [${bodyOf(readPeople()).length} chars]`;
    } catch (err) {
      logger.error({ err }, "people remove failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};
