import { getDiscordClient } from "../tools/builtin/discord.js";
import { extractMessageAttachments } from "./discord-message.js";
import { logger } from "../logger.js";

/**
 * Discord CDN attachment URLs are signed and time-limited: `?ex=…&is=…&hm=…`. Once the `ex`
 * (expiry) timestamp passes, the CDN answers 403/404. The durable fix is to re-resolve the
 * ORIGINAL message through the authenticated Discord client and read the attachment's current,
 * freshly-signed `url`.
 *
 * Security: refresh is only ever attempted against the EXACT channel/message/attachment IDs
 * that were recorded when the attachment was first ingested from a Discord message. Nothing
 * here takes a caller- or model-supplied message/channel — there is no path for a non-owner to
 * point this at an arbitrary message, so it cannot be used for SSRF or cross-channel data
 * access. Rows without provenance simply cannot be refreshed.
 */

export interface AttachmentRefreshProvenance {
  channelId: string | null;
  messageId: string | null;
  attachmentId: string | null;
  /** The currently-stored URL, used to detect whether Discord handed us a genuinely new one. */
  currentUrl: string | null;
}

/** Whether an HTTP failure looks like an expired/removed signed CDN URL worth refreshing. */
export function isRefreshableCdnStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 410;
}

/**
 * A Discord attachment URL whose signed-expiry (`ex`) query parameter is already in the past.
 * Lets the worker refresh proactively instead of waiting for the download to 403.
 */
export function isDiscordCdnUrlExpired(url: string | null | undefined, nowMs = Date.now()): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isDomain = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (!isDomain("discordapp.com") && !isDomain("discordapp.net") && !isDomain("discord.com")) return false;
    const ex = parsed.searchParams.get("ex");
    if (!ex) return false;
    const expirySeconds = parseInt(ex, 16);
    if (!Number.isFinite(expirySeconds)) return false;
    // Refresh a little early to avoid racing the boundary.
    return expirySeconds * 1000 <= nowMs + 30_000;
  } catch {
    return false;
  }
}

/** True when the row has enough provenance to attempt a refresh at all. */
export function canRefresh(p: AttachmentRefreshProvenance): boolean {
  return Boolean(p.channelId && p.messageId && p.attachmentId);
}

/**
 * Re-fetch the original Discord message and return the current signed URL for the recorded
 * attachment ID. Returns null when the client is unavailable, the message/attachment is gone,
 * or provenance is missing. Never throws — refresh is best-effort and its failure must not be
 * mistaken for a permanent processing failure.
 */
export async function refreshDiscordAttachmentUrl(p: AttachmentRefreshProvenance): Promise<string | null> {
  if (!canRefresh(p)) return null;
  const client = getDiscordClient();
  if (!client?.isReady()) {
    logger.warn({ channelId: p.channelId, messageId: p.messageId }, "attachment refresh skipped: Discord client not ready");
    return null;
  }
  try {
    const channel = await client.channels.fetch(p.channelId!);
    if (!channel || !("messages" in channel)) return null;
    const message = await (channel as { messages: { fetch: (id: string) => Promise<unknown> } }).messages.fetch(p.messageId!);
    const found = extractMessageAttachments(message as Parameters<typeof extractMessageAttachments>[0])
      .find(item => item.discordAttachmentId === p.attachmentId);
    if (!found?.url) return null;
    // Only report a URL that is actually different (or at least freshly signed).
    if (found.url === p.currentUrl) return null;
    return found.url;
  } catch (err) {
    logger.warn({ err: (err as Error).message, channelId: p.channelId, messageId: p.messageId }, "attachment refresh failed to re-resolve URL");
    return null;
  }
}
