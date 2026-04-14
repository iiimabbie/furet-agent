import { exec } from "node:child_process";
import { logger } from "../../logger.js";

export const bashDefinition = {
  type: "function" as const,
  function: {
    name: "bash",
    description: "Execute a shell command and return stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
      },
      required: ["command"],
    },
  },
};

export async function executeBash(args: { command: string }): Promise<string> {
  logger.info({ command: args.command }, "bash exec");
  return new Promise((resolve) => {
    exec(args.command, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (err && !output) {
        resolve(`Error: ${err.message}`);
      } else {
        resolve(output || "(no output)");
      }
    });
  });
}
