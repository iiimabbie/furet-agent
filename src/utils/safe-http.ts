import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface SafeFetchBufferOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  allowPrivateAddresses?: boolean;
}

export interface SafeFetchBufferResult {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family === 6) return !isPrivateIpv6(address);
  return false;
}

async function resolvePublicAddress(hostname: string, allowPrivateAddresses: boolean): Promise<{ address: string; family: 4 | 6 }> {
  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost") || hostname.toLowerCase().endsWith(".local")) {
    throw new Error("private or local attachment host is not allowed");
  }
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!allowPrivateAddresses && !isPublicIpAddress(hostname)) throw new Error("private attachment address is not allowed");
    return { address: hostname, family: literalFamily as 4 | 6 };
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const selected = addresses.find(candidate => allowPrivateAddresses || isPublicIpAddress(candidate.address));
  if (!selected) throw new Error("attachment host resolved only to private or unsupported addresses");
  return { address: selected.address, family: selected.family as 4 | 6 };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

export async function safeFetchBuffer(urlValue: string, options: SafeFetchBufferOptions): Promise<SafeFetchBufferResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 4;
  const allowPrivateAddresses = options.allowPrivateAddresses ?? false;

  async function fetchOne(current: URL, redirects: number): Promise<SafeFetchBufferResult> {
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new Error("unsupported URL protocol");
    if (current.username || current.password) throw new Error("URLs containing credentials are not allowed");
    const pinned = await resolvePublicAddress(current.hostname, allowPrivateAddresses);
    const requester = current.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<SafeFetchBufferResult>((resolve, reject) => {
      let settled = false;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const req = requester({
        protocol: current.protocol,
        hostname: current.hostname,
        port: current.port || undefined,
        path: `${current.pathname}${current.search}`,
        method: "GET",
        headers: { "User-Agent": "Furet-AttachmentIndexer/1.0", ...(options.headers ?? {}) },
        lookup: (_hostname, _lookupOptions, callback) => callback(null, pinned.address, pinned.family),
      }, response => {
        const status = response.statusCode ?? 0;
        const location = headerValue(response.headers.location);
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirects >= maxRedirects) return finishError(new Error("too many redirects"));
          const target = new URL(location, current);
          void fetchOne(target, redirects + 1).then(result => {
            if (settled) return;
            settled = true;
            resolve(result);
          }, finishError);
          return;
        }

        const declared = Number(headerValue(response.headers["content-length"]) ?? 0);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy();
          return finishError(new Error(`response exceeds ${options.maxBytes} byte limit`));
        }

        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > options.maxBytes) {
            response.destroy(new Error(`response exceeds ${options.maxBytes} byte limit`));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("error", finishError);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            const rendered = headerValue(value);
            if (rendered !== undefined) headers[key.toLowerCase()] = rendered;
          }
          resolve({ status, ok: status >= 200 && status < 300, url: current.toString(), headers, body: Buffer.concat(chunks) });
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
      req.on("error", finishError);
      req.end();
    });
  }

  return fetchOne(new URL(urlValue), 0);
}
