import { logger } from "../../logger.js";
import { loadConfig } from "../../config.js";
import { ask } from "../../agent.js";
import { ROOT } from "../../paths.js";
import type { Tool } from "../../types.js";

const CODING_SYSTEM_PROMPT = `You are modifying the Furet agent's own source code. Furet is a TypeScript project at ${ROOT}/.

Before making changes:
1. Read DESIGN.md for architecture overview
2. Read the relevant source files to understand the current implementation

Rules:
- Follow the existing code style and patterns
- After writing files, run \`npx tsc --noEmit\` via bash to verify no type errors
- Update DESIGN.md if you changed the architecture
- Do NOT commit code — the owner will review and commit
- Do NOT restart the gateway — the owner will do it

To add a new tool:
1. Create src/tools/builtin/<name>.ts exporting Tool objects
2. Import and register in src/tools/registry.ts`;

export const selfEvolve: Tool = {
  name: "self_evolve",
  description: "Modify Furet's own source code using a stronger AI model. Use this when you need to add features, fix bugs, or improve yourself. Describe what you want to change clearly.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "What to implement or change. Be specific about the goal and any relevant context." },
    },
    required: ["task"],
  },
  execute: async (args) => {
    const { task } = args as { task: string };
    const config = loadConfig();
    const model = config.llm.codingModel || config.llm.currentModel;

    logger.info({ task: task.slice(0, 200), model }, "self_evolve triggered");

    try {
      const response = await ask(task, {
        systemPrompt: CODING_SYSTEM_PROMPT,
        model,
        maxTurns: 30,
        trigger: "unknown",
      });

      logger.info({
        model,
        durationMs: response.durationMs,
        toolsUsed: response.toolsUsed.map(t => t.tool),
        usage: response.usage,
      }, "self_evolve completed");

      return response.text || "(completed with no text output)";
    } catch (err) {
      logger.error({ err: (err as Error).message }, "self_evolve failed");
      return `Error: ${(err as Error).message}`;
    }
  },
};
