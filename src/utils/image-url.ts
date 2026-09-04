/**
 * Discord serves resized renditions of uploaded images, and models are billed by image
 * tokens that scale with pixel count. Neither a conversation nor the search index needs
 * full-resolution pixels to read text, UI state, and subjects, so images bound for a model
 * are requested at a bounded edge instead of their original size.
 */

/** Only this host performs the resize; `cdn.discordapp.com` ignores the parameters. */
const CDN_HOST = "cdn.discordapp.com";
const RESIZING_HOST = "media.discordapp.net";

/** Longest edge requested for images sent to a model. */
export const MODEL_IMAGE_EDGE = 768;

/**
 * Rewrite a Discord image URL to a bounded rendition, preserving aspect ratio.
 *
 * Discord scales to EXACTLY the width/height asked for rather than fitting inside a box, so
 * the target is computed from the source dimensions; without them the URL is returned
 * unchanged rather than risking a distorted image. Existing query parameters are preserved:
 * attachment links carry a signature (`ex`/`is`/`hm`) that must survive intact.
 */
export function boundedImageUrl(
  url: string,
  width?: number,
  height?: number,
  edge: number = MODEL_IMAGE_EDGE,
): string {
  if (!width || !height || width <= 0 || height <= 0) return url;
  if (width <= edge && height <= edge) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== CDN_HOST && parsed.hostname !== RESIZING_HOST) return url;
    const scale = edge / Math.max(width, height);
    parsed.hostname = RESIZING_HOST;
    parsed.searchParams.set("width", String(Math.max(1, Math.round(width * scale))));
    parsed.searchParams.set("height", String(Math.max(1, Math.round(height * scale))));
    return parsed.toString();
  } catch {
    return url;
  }
}
