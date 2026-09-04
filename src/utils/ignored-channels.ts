import type { UmiroConfig } from "../config.js";

/**
 * Whether a channel / thread should be completely ignored at the Discord message
 * entrypoint. When true the message is dropped before any trigger evaluation,
 * session creation, or record-keeping — regardless of mention, reply-to-bot, DM,
 * or ambient status. Matching is exact on the channel/thread ID itself; a thread
 * does NOT inherit its parent channel's ignore status (threads carry their own ID).
 *
 * This is intentionally the highest-priority gate: `ignored_channels` overrides
 * `ambient_channels`, `allowed_channels`, mentions, and DMs.
 */
export function isIgnoredChannel(channelId: string, config: UmiroConfig): boolean {
  return config.discord.ignored_channels.includes(channelId);
}
