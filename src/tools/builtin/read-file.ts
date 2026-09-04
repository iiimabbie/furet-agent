import { open, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { logger } from "../../logger.js";
import { checkFileAccess } from "../guard.js";
import type { Tool } from "../../types.js";

/**
 * Cap on how much of a file reaches the model.
 *
 * A tool result goes straight into the next request, so an unbounded read turns one
 * oversized file — a log, a lockfile, a build artifact — into a hard context-window 400 that
 * aborts the whole turn. Truncating instead keeps the turn alive and, with the notice below,
 * leaves the model able to fetch the part it actually wanted.
 */
const MAX_READ_CHARS = 64_000;
/** UTF-8 is at most 4 bytes per code point; reading this much guarantees MAX_READ_CHARS. */
const MAX_READ_BYTES = MAX_READ_CHARS * 4;

function truncationNotice(path: string, totalBytes: number, shownChars: number): string {
  return [
    "",
    "",
    `[truncated: showed the first ${shownChars.toLocaleString()} characters of ${path},`,
    `which is ${totalBytes.toLocaleString()} bytes in total.`,
    "This is the START of the file — for a log or any append-ordered file the part you want is",
    "usually at the END. Do not call read_file on it again; it returns this same prefix.",
    "Use bash instead to fetch only what you need, e.g.:",
    `  tail -n 200 ${path}`,
    `  grep -n "<pattern>" ${path} | tail -n 50`,
    `  sed -n '<start>,<end>p' ${path}`,
    "]",
  ].join("\n");
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file at the given path. Prefer this over bash cat/head/tail — it returns cleaner output. Output is capped, so very large files come back truncated with instructions for reading the rest. MEMORY.md and OWNER.md are already in your prompt; re-reading them wastes a turn.",
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
      const info = await stat(path);
      if (info.size <= MAX_READ_CHARS) return await readFile(path, "utf-8");

      // Large file: read a bounded prefix rather than pulling the whole thing into memory.
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(Math.min(MAX_READ_BYTES, info.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = buffer.subarray(0, bytesRead).toString("utf-8").slice(0, MAX_READ_CHARS);
        if (text.length >= info.size) return text;
        logger.info({ path, totalBytes: info.size, shownChars: text.length }, "read_file truncated");
        return text + truncationNotice(path, info.size, text.length);
      } finally {
        await handle.close();
      }
    } catch (err) {
      return `Error reading file: ${(err as Error).message}`;
    }
  },
};
