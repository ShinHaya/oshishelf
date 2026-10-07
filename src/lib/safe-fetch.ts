import "server-only";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;

/**
 * Non-public ranges (private, loopback, link-local, CGNAT, documentation, multicast, translation…).
 * Kept per family: a BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules.
 */
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_V4.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  // Unspecified, loopback and IPv4-compatible addresses.
  ["::", 96],
  // IPv4-mapped, NAT64 and 6to4 can all reach IPv4 space, including internal ranges.
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_V6.addSubnet(prefix, bits, "ipv6");
}

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;
  return family === 4 ? BLOCKED_V4.check(ip, "ipv4") : BLOCKED_V6.check(ip, "ipv6");
}

interface Target {
  url: URL;
  address: string;
  family: number;
}

/** Validate the URL and resolve it once; the connection is then pinned to this address. */
async function resolvePublic(raw: string): Promise<Target> {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("unsupported protocol");
  if (u.username || u.password) throw new Error("credentials in url");
  if (u.hostname === "metadata.google.internal" || u.hostname.endsWith(".internal")) throw new Error("blocked host");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) throw new Error("blocked address");
  return { url: u, address: addrs[0].address, family: addrs[0].family };
}

type LookupCallback = (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void;

/** DNS lookup for the socket that always answers with the already-validated address (no rebinding). */
export function pinnedLookup(address: string, family: number) {
  return (_hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function request(t: Target, headers: Record<string, string>, signal: AbortSignal): Promise<http.IncomingMessage> {
  const mod = t.url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(t.url, { method: "GET", headers, signal, lookup: pinnedLookup(t.address, t.family) as never }, resolve);
    req.on("error", reject);
    req.end();
  });
}

function decoded(res: http.IncomingMessage): Readable {
  const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") return res.pipe(zlib.createGunzip());
  if (enc === "deflate") return res.pipe(zlib.createInflate());
  if (enc === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/** Read at most MAX_BYTES of the (decompressed) body. */
async function readBody(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let received = 0;
  const body = decoded(res);
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      received += buf.byteLength;
      if (received > MAX_BYTES) break;
    }
  } finally {
    body.destroy();
    res.destroy();
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

/**
 * Fetch a user-supplied URL with SSRF protection: only public http(s) hosts, each hop resolved once and
 * the socket pinned to that validated address, redirects re-validated hop by hop, bounded size and time.
 */
export async function safeFetchText(raw: string, init: { cookie?: string } = {}): Promise<{ url: string; status: number; text: string }> {
  let current = raw;
  for (let hop = 0; hop < 5; hop++) {
    const target = await resolvePublic(current);
    const res = await request(
      target,
      {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 OshiShelfBot/1.0",
        "accept-language": "ja,en;q=0.8",
        accept: "text/html,application/xhtml+xml",
        "accept-encoding": "gzip, deflate, br",
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      AbortSignal.timeout(TIMEOUT_MS),
    );
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.destroy();
      current = new URL(location, target.url).toString();
      continue;
    }
    return { url: target.url.toString(), status, text: await readBody(res) };
  }
  throw new Error("too many redirects");
}
