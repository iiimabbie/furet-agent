import { writeFile, mkdir } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { logger } from "../../logger.js";
import { addVector, removeVectorsByFile } from "../../embedding.js";
import type { Tool } from "../../types.js";

const VECTORIZE_FILES = new Set(["PEOPLE.md"]);
const VECTORIZE_PATTERNS = [/^\d{4}-\d{2}-\d{2}\.md$/]; // 日記檔 YYYY-MM-DD.md

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file, creating parent directories as needed. Not for memory or people: memory_add / memory_replace and people_add / people_update edit the right part of those files and keep their wrapper tags intact, which a whole-file overwrite destroys.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" },
      content: { type: "string", description: "The content to write" },
    },
    required: ["path", "content"],
  },
  execute: async (args) => {
    const { path, content } = args as { path: string; content: string };
    logger.info({ path }, "write_file");
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      // PEOPLE.md 等重要檔案寫入時，內容拆段存向量
      const fileName = basename(path);
      if (VECTORIZE_FILES.has(fileName) || VECTORIZE_PATTERNS.some(p => p.test(fileName))) {
        // 先清舊向量，再存新的
        removeVectorsByFile(fileName);
        const paragraphs = content.split(/\n{2,}/).filter(p => p.trim().length > 20);
        for (const p of paragraphs) {
          addVector(p.trim(), basename(path)).catch(() => {});
        }
      }
      return `File written: ${path}`;
    } catch (err) {
      return `Error writing file: ${(err as Error).message}`;
    }
  },
};
