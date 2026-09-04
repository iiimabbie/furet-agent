import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface SafeFetchBufferOptions {
  maxBytes: number;
  /**
   * Idle timeout: max time a single socket may stall without progress. Applied per
   * hop and re-armed on data. A slow-drip server that keeps trickling bytes cannot
   * escape it because the absolute deadline below still applies.
   */
  idleTimeoutMs?: number;
  /**
   * Absolute wall-clock budget for the whole operation, shared across every redirect
   * hop and every socket. Once it elapses the request is aborted regardless of idle
   * activity.
   */
  deadlineMs?: number;
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

/**
 * Parse an IPv4 string into its four octets, or null if it is not a strict,
 * unambiguous dotted-quad. Rejects octal/hex/short forms that some resolvers
 * accept but that would let an attacker smuggle a private address past us.
 */
function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // Reject leading zeros (e.g. "010") to avoid octal-style ambiguity.
    if (part.length > 1 && part[0] === "0") return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/**
 * Expand any RFC 4291 IPv6 text form into its 8 16-bit groups. Handles `::`
 * compression, embedded IPv4 tails (including IPv4-mapped and NAT64 forms), and
 * strips a zone identifier. Returns null when the literal is not valid IPv6.
 */
function parseIpv6(address: string): number[] | null {
  let value = address.split("%")[0].toLowerCase(); // drop zone identifier
  if (value === "") return null;

  // An embedded IPv4 tail contributes the low 32 bits as two groups.
  let ipv4Tail: [number, number, number, number] | null = null;
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    ipv4Tail = parseIpv4(tail);
    if (!ipv4Tail) return null;
    value = value.slice(0, lastColon + 1); // keep the trailing colon for splitting
  }

  const doubleColon = value.indexOf("::");
  let head: string[];
  let back: string[];
  if (doubleColon >= 0) {
    if (value.indexOf("::", doubleColon + 1) >= 0) return null; // only one "::" allowed
    head = value.slice(0, doubleColon).split(":").filter(Boolean);
    back = value.slice(doubleColon + 2).split(":").filter(Boolean);
  } else {
    head = value.split(":").filter(Boolean);
    back = [];
  }

  const groups: number[] = [];
  for (const group of head) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  const backGroups: number[] = [];
  for (const group of back) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    backGroups.push(parseInt(group, 16));
  }

  const tailGroups: number[] = ipv4Tail
    ? [(ipv4Tail[0] << 8) | ipv4Tail[1], (ipv4Tail[2] << 8) | ipv4Tail[3]]
    : [];

  const explicit = groups.length + backGroups.length + tailGroups.length;
  if (doubleColon >= 0) {
    const fill = 8 - explicit;
    if (fill < 1) return null; // "::" must stand for at least one zero group
    return [...groups, ...new Array(fill).fill(0), ...backGroups, ...tailGroups];
  }
  if (explicit !== 8) return null;
  return [...groups, ...backGroups, ...tailGroups];
}

function isPrivateIpv4Octets(o: [number, number, number, number]): boolean {
  const [a, b] = o;
  return a === 0                                  // 0.0.0.0/8 "this host"
    || a === 10                                   // 10/8 private
    || a === 127                                  // loopback
    || (a === 100 && b >= 64 && b <= 127)         // 100.64/10 CGNAT
    || (a === 169 && b === 254)                   // link-local
    || (a === 172 && b >= 16 && b <= 31)          // 172.16/12 private
    || (a === 192 && b === 0)                      // 192.0.0/24 & 192.0.2/24
    || (a === 192 && b === 88 && o[2] === 99)     // 6to4 relay anycast
    || (a === 192 && b === 168)                    // 192.168/16 private
    || (a === 198 && (b === 18 || b === 19))       // benchmarking
    || (a === 198 && b === 51 && o[2] === 100)     // TEST-NET-2
    || (a === 203 && b === 0 && o[2] === 113)      // TEST-NET-3
    || a >= 224;                                    // multicast + reserved + broadcast
}

/** Reject any IPv4 that is not a normal globally-routable unicast address. */
export function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return true; // unparseable -> treat as unsafe
  return isPrivateIpv4Octets(octets);
}

/** Reject any IPv6 that is not a normal globally-routable unicast address. */
export function isPrivateIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return true; // unparseable -> treat as unsafe

  const [g0, g1, g2, g3] = groups;
  const allZeroExceptLast = groups.slice(0, 7).every(g => g === 0);
  // :: (unspecified) and ::1 (loopback)
  if (allZeroExceptLast && (groups[7] === 0 || groups[7] === 1)) return true;

  // IPv4-mapped ::ffff:0:0/96 -> validate the embedded IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const v4a = (groups[6] >> 8) & 0xff, v4b = groups[6] & 0xff;
    const v4c = (groups[7] >> 8) & 0xff, v4d = groups[7] & 0xff;
    return isPrivateIpv4Octets([v4a, v4b, v4c, v4d]);
  }
  // Deprecated IPv4-compatible ::a.b.c.d/96 (excluding :: and ::1 handled above).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && groups[4] === 0 && groups[5] === 0) {
    const v4a = (groups[6] >> 8) & 0xff, v4b = groups[6] & 0xff;
    const v4c = (groups[7] >> 8) & 0xff, v4d = groups[7] & 0xff;
    return isPrivateIpv4Octets([v4a, v4b, v4c, v4d]);
  }
  // NAT64 well-known prefix 64:ff9b::/96 and 64:ff9b:1::/48 embed an IPv4 tail
  // whose privateness must be checked, or a public IPv4 gets masked behind IPv6.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && groups[4] === 0 && groups[5] === 0) {
    const v4a = (groups[6] >> 8) & 0xff, v4b = groups[6] & 0xff;
    const v4c = (groups[7] >> 8) & 0xff, v4d = groups[7] & 0xff;
    return isPrivateIpv4Octets([v4a, v4b, v4c, v4d]);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0x0001) {
    // 64:ff9b:1::/48 local-use NAT64 — always treat as non-routable.
    return true;
  }

  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 documentation
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  // 2001:0000::/32 Teredo — tunnels arbitrary endpoints, treat as unsafe.
  if (g0 === 0x2001 && g1 === 0x0000) return true;
  // 2002::/16 6to4 — embeds an IPv4 in groups[1..2]; block to avoid bypass.
  if (g0 === 0x2002) {
    const v4a = (g1 >> 8) & 0xff, v4b = g1 & 0xff;
    const v4c = (g2 >> 8) & 0xff, v4d = g2 & 0xff;
    return isPrivateIpv4Octets([v4a, v4b, v4c, v4d]);
  }
  // 100::/64 discard-only
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;

  return false;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address.split("%")[0]);
  if (family === 4) return !isPrivateIpv4(address);
  if (family === 6) return !isPrivateIpv6(address);
  return false;
}

async function resolvePublicAddress(hostname: string, allowPrivateAddresses: boolean): Promise<{ address: string; family: 4 | 6 }> {
  const lowered = hostname.toLowerCase();
  if (lowered === "localhost" || lowered.endsWith(".localhost") || lowered.endsWith(".local")) {
    throw new Error("private or local host is not allowed");
  }
  const literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (literal.includes("%")) throw new Error("scoped IPv6 addresses are not allowed");
  const literalFamily = isIP(literal);
  if (literalFamily) {
    if (!allowPrivateAddresses && !isPublicIpAddress(literal)) throw new Error("private or reserved address is not allowed");
    return { address: literal, family: literalFamily as 4 | 6 };
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const selected = addresses.find(candidate => allowPrivateAddresses || isPublicIpAddress(candidate.address));
  if (!selected) throw new Error("host resolved only to private or unsupported addresses");
  return { address: selected.address, family: selected.family as 4 | 6 };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

export async function safeFetchBuffer(urlValue: string, options: SafeFetchBufferOptions): Promise<SafeFetchBufferResult> {
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  // Absolute budget defaults generously relative to the idle timeout so a legitimate
  // multi-hop download is not cut off, but a redirect loop or slow-drip cannot run
  // forever. Callers may override with deadlineMs.
  const deadlineMs = options.deadlineMs ?? Math.max(idleTimeoutMs * 4, 120_000);
  const maxRedirects = options.maxRedirects ?? 4;
  const allowPrivateAddresses = options.allowPrivateAddresses ?? false;
  const deadlineAt = Date.now() + deadlineMs;

  function remainingBudget(): number {
    return deadlineAt - Date.now();
  }

  async function fetchOne(current: URL, redirects: number): Promise<SafeFetchBufferResult> {
    if (remainingBudget() <= 0) throw new Error(`request exceeded ${deadlineMs}ms deadline`);
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new Error("unsupported URL protocol");
    if (current.username || current.password) throw new Error("URLs containing credentials are not allowed");
    // Re-resolve and re-validate DNS on every hop, then pin the connection to the
    // exact vetted IP so a rebinding TOCTOU cannot swap in a private address.
    const dnsBudget = remainingBudget();
    if (dnsBudget <= 0) throw new Error(`request exceeded ${deadlineMs}ms deadline`);
    let dnsTimer: NodeJS.Timeout | undefined;
    const pinned = await Promise.race([
      resolvePublicAddress(current.hostname, allowPrivateAddresses),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(() => reject(new Error(`request exceeded ${deadlineMs}ms deadline during DNS resolution`)), dnsBudget);
        dnsTimer.unref?.();
      }),
    ]).finally(() => { if (dnsTimer) clearTimeout(dnsTimer); });
    const requester = current.protocol === "https:" ? httpsRequest : httpRequest;
    const requestHostname = current.hostname.startsWith("[") && current.hostname.endsWith("]")
      ? current.hostname.slice(1, -1)
      : current.hostname;

    return new Promise<SafeFetchBufferResult>((resolve, reject) => {
      let settled = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        reject(error);
      };
      const finishOk = (result: SafeFetchBufferResult) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        resolve(result);
      };

      // @types/node in the project's TypeScript baseline predates this Node runtime's
      // `autoSelectFamily` request option. Keep the narrow compatibility type here;
      // Node 24 accepts the option and forwards it to net.connect().
      const requestOptions = {
        protocol: current.protocol,
        hostname: current.hostname,
        port: current.port || undefined,
        path: `${current.pathname}${current.search}`,
        method: "GET",
        headers: { "User-Agent": "Furet-AttachmentIndexer/1.0", ...(options.headers ?? {}) },
        // The custom lookup deliberately returns exactly the vetted, pinned address.
        // Disable Node's multi-address family racing: with autoSelectFamily enabled it
        // asks lookup() for an all-address result and treats a single pinned answer as
        // malformed. This keeps the DNS-rebinding protection intact without allowing
        // Node to perform a second, unvalidated resolution.
        autoSelectFamily: false,
        lookup: (_hostname: string, _lookupOptions: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, pinned.address, pinned.family),
      };
      const req = requester(requestOptions as unknown as import("node:http").RequestOptions, response => {
        const status = response.statusCode ?? 0;
        const location = headerValue(response.headers.location);
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirects >= maxRedirects) return finishError(new Error("too many redirects"));
          let target: URL;
          try { target = new URL(location, current); }
          catch { return finishError(new Error("redirect target is not a valid URL")); }
          // The next hop re-validates DNS and re-pins inside fetchOne; the shared
          // deadline keeps ticking across the whole redirect chain.
          void fetchOne(target, redirects + 1).then(finishOk, finishError);
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
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            const rendered = headerValue(value);
            if (rendered !== undefined) headers[key.toLowerCase()] = rendered;
          }
          finishOk({ status, ok: status >= 200 && status < 300, url: current.toString(), headers, body: Buffer.concat(chunks) });
        });
      });

      // Idle timeout: fires when the socket stalls with no activity. Node re-arms it
      // on socket activity, so a steadily trickling server keeps it from firing —
      // that is what the absolute deadline below is for.
      req.setTimeout(idleTimeoutMs, () => req.destroy(new Error(`request stalled: no activity for ${idleTimeoutMs}ms`)));
      // Absolute wall-clock deadline for THIS hop, bounded by the remaining shared
      // budget so a slow-drip transfer that never idles is still cut off.
      const hopBudget = remainingBudget();
      if (hopBudget <= 0) { req.destroy(new Error(`request exceeded ${deadlineMs}ms deadline`)); return; }
      deadlineTimer = setTimeout(() => req.destroy(new Error(`request exceeded ${deadlineMs}ms deadline`)), hopBudget);
      deadlineTimer.unref?.();
      req.on("error", finishError);
      req.end();
    });
  }

  let start: URL;
  try { start = new URL(urlValue); }
  catch { throw new Error("invalid URL"); }
  return fetchOne(start, 0);
}
