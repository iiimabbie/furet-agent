import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../../logger.js";

export const writeFileDefinition = {
  type: "function" as const,
  function: {
    name: "write_file",
    description: "Write content to a file. Creates parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["path", "content"],
    },
  },
};

export async function executeWriteFile(args: { path: string; content: string }): Promise<string> {
  logger.info({ path: args.path }, "write_file");
  try {
    await mkdir(dirname(args.path), { recursive: true });
    await writeFile(args.path, args.content, "utf-8");
    return `File written: ${args.path}`;
  } catch (err) {
    return `Error writing file: ${(err as Error).message}`;
  }
}
