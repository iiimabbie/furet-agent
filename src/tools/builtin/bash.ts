import { exec } from "node:child_process";
import { logger } from "../../logger.js";
import type { Tool } from "../../types.js";

export const bash: Tool = {
  name: "bash",
  description: "Execute a shell command and return stdout/stderr. 30s timeout, 1MB output cap.\n\nUse for multi-step execution: write a script and run it, rather than chaining many small calls. Always pass non-interactive flags (-y, --yes, --no-input) — there is no stdin, so a prompt will hang until the timeout.\n\nDo NOT use for file inspection: read_file, write_file, grep, and glob exist for that and give better output. Reaching for cat/grep/ls here just to look busy wastes a turn.\n\nPrefer recoverable operations: mv to .trash rather than rm.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
    },
    required: ["command"],
  },
  execute: async (args) => {
    const { command } = args as { command: string };
    logger.info({ command }, "bash exec");
    return new Promise((resolve) => {
      exec(command, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (err && !output) {
          resolve(`Error: ${err.message}`);
        } else {
          resolve(output || "(no output)");
        }
      });
    });
  },
};
