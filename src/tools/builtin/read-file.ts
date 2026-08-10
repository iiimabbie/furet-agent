import { readFile } from "node:fs/promises";
import { logger } from "../../logger.js";
import { checkFileAccess } from "../guard.js";
import type { Tool } from "../../types.js";

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file at the given path.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" },
    },
    required: ["path"],
  },
  execute: async (args) => {
    const { path } = args as { path: string };
    logger.info({ path }, "read_file");
    const denied = checkFileAccess(path);
    if (denied) {
      logger.warn({ path }, "read_file denied by guard");
      return denied;
    }
    try {
      return await readFile(path, "utf-8");
    } catch (err) {
      return `Error reading file: ${(err as Error).message}`;
    }
  },
};
