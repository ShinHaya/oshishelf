import "server-only";
import { lookup } from "node:dns/promises";
import net from "node:net";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("unsupported protocol");
  if (u.username || u.password) throw new Error("credentials in url");
  if (u.hostname === "metadata.google.internal" || u.hostname.endsWith(".internal")) throw new Error("blocked host");
  const addrs = await lookup(u.hostname, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new Error("blocked address");
  return u;
}

/**
 * Fetch a user-supplied URL with SSRF protection: only public http(s) hosts,
 * redirects re-validated hop by hop, bounded size and time.
 */
export async function safeFetchText(raw: string, init: { cookie?: string } = {}): Promise<{ url: string; status: number; text: string }> {
  let current = raw;
  for (let hop = 0; hop < 5; hop++) {
    const u = await assertPublicUrl(current);
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 OshiShelfBot/1.0",
        "accept-language": "ja,en;q=0.8",
        accept: "text/html,application/xhtml+xml",
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    const reader = res.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        chunks.push(value);
        if (received > MAX_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
    return { url: u.toString(), status: res.status, text };
  }
  throw new Error("too many redirects");
}
