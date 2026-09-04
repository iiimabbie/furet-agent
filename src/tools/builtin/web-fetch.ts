import type { Tool } from "../../types.js";
import { safeFetchBuffer } from "../../utils/safe-http.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 50_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export const webFetch: Tool = {
  name: "web_fetch",
  description: "Fetch a public HTTP(S) URL through Furet's SSRF-safe downloader and return bounded readable text. Private, loopback, link-local, credential-bearing and oversized responses are rejected.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Public HTTP(S) URL to fetch." } },
    required: ["url"],
  },
  execute: async args => {
    const url = String(args.url ?? "").trim();
    if (!url) return "Error: url is required";
    const response = await safeFetchBuffer(url, { maxBytes: MAX_BYTES, idleTimeoutMs: 20_000, deadlineMs: 60_000, maxRedirects: 4 });
    if (!response.ok) return `Error: HTTP ${response.status} fetching ${response.url}`;
    const contentType = response.headers["content-type"] ?? "";
    const raw = response.body.toString("utf8");
    const text = /html|xml/i.test(contentType) ? htmlToText(raw) : raw.trim();
    return JSON.stringify({ url: response.url, content_type: contentType, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT });
  },
};
