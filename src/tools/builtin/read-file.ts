import { readFile } from "node:fs/promises";
import { logger } from "../../logger.js";

export const readFileDefinition = {
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Read the contents of a file at the given path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
      },
      required: ["path"],
    },
  },
};

export async function executeReadFile(args: { path: string }): Promise<string> {
  logger.info({ path: args.path }, "read_file");
  try {
    const content = await readFile(args.path, "utf-8");
    return content;
  } catch (err) {
    return `Error reading file: ${(err as Error).message}`;
  }
}
