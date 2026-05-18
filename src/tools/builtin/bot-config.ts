import { setRespondToBots, loadConfig } from "../../config.js";
import type { Tool } from "../../types.js";

export const discordBotMentionToggle: Tool = {
  name: "discord_bot_mention_toggle",
  description: "Enable or disable responding to other bots. When enabled, messages from other bots that mention Furet or are in DM will trigger the agent.",
  parameters: {
    type: "object",
    properties: {
      enabled: { type: "boolean", description: "true to respond to bots, false to ignore them" },
    },
    required: ["enabled"],
  },
  execute: async (args) => {
    const { enabled } = args as { enabled: boolean };
    setRespondToBots(enabled);
    return `respond_to_bots is now ${enabled ? "enabled" : "disabled"}.`;
  },
};
