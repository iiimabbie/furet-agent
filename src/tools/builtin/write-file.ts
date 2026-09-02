import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../../logger.js";
import { reindexWorkspacePath } from "../../workspace-index.js";
import type { Tool } from "../../types.js";


export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file, creating parent directories as needed. Use this for OWNER.md only after preserving its <owner> wrapper and unrelated fields. Do not whole-file overwrite MEMORY.md or PEOPLE.md; use memory_* or people_* tools so their wrappers and structure remain intact.",
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
      reindexWorkspacePath(path, content);
      return `File written: ${path}`;
    } catch (err) {
      return `Error writing file: ${(err as Error).message}`;
    }
  },
};
