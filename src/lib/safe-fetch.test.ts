import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:http", () => ({ default: { request: vi.fn() } }));
vi.mock("node:https", () => ({ default: { request: vi.fn() } }));

import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isBlockedAddress, safeFetchText } from "./safe-fetch";

const dns = vi.mocked(lookup);
const httpRequest = vi.mocked(http.request);
const httpsRequest = vi.mocked(https.request);

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

type Lookup = (host: string, opts: { all?: boolean }, cb: (err: Error | null, address: unknown, family?: number) => void) => void;

/** Fake http(s).request: resolves the host through the `lookup` option the code passes, like a real socket would. */
function serve(...responses: FakeResponse[]) {
  const connected: string[] = [];
  const impl = ((url: URL, opts: { lookup: Lookup }, onResponse: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = () => {};
    req.end = () => {
      opts.lookup(url.hostname, { all: true }, (_err, addrs) => {
        connected.push((addrs as { address: string }[])[0].address);
        const r = responses.shift() ?? {};
        const res = Object.assign(Readable.from(r.body === undefined ? [] : [Buffer.from(r.body)]), {
          statusCode: r.status ?? 200,
          headers: r.headers ?? {},
        });
        onResponse(res);
      });
    };
    return req;
  }) as never;
  httpRequest.mockImplementation(impl);
  httpsRequest.mockImplementation(impl);
  return connected;
}

beforeEach(() => {
  dns.mockReset();
  httpRequest.mockReset();
  httpsRequest.mockReset();
});

describe("外部URLの取得境界", () => {
  it.each([
    ["file:///etc/passwd", "unsupported protocol"],
    ["https://user:password@example.com/", "credentials in url"],
    ["http://metadata.google.internal/", "blocked host"],
    ["http://127.0.0.1/", "blocked address"],
    ["http://[::1]/", "blocked address"],
  ])("%s は取得前に拒否する", async (url, message) => {
    serve();
    await expect(safeFetchText(url)).rejects.toThrow(message);
    expect(httpRequest).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "192.0.0.170",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:a9fe:a9fe::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
  ])("DNSが内部・特殊用途のIP %s を返した場合は取得しない", async (address) => {
    dns.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }] as never);
    serve();
    await expect(safeFetchText("https://example.com/")).rejects.toThrow("blocked address");
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it.each(["93.184.216.34", "2606:4700::6810:84e5"])("公開IP %s は許可する", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("公開IPと内部IPが混在するホストも拒否する", async () => {
    dns.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ] as never);
    serve();
    await expect(safeFetchText("https://example.com/")).rejects.toThrow("blocked address");
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it("検証済みのIPに接続し、接続時に名前解決をやり直さない（DNSリバインディング対策）", async () => {
    // A rebinding resolver answers with a public IP first, then an internal one.
    dns.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never).mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as never);
    const connected = serve({ body: "商品ページ" });
    await expect(safeFetchText("https://rebind.example/")).resolves.toEqual({ url: "https://rebind.example/", status: 200, text: "商品ページ" });
    expect(connected).toEqual(["93.184.216.34"]);
    expect(dns).toHaveBeenCalledTimes(1);
  });

  it("公開ホストから内部IPへのリダイレクトも再検証する", async () => {
    dns.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    serve({ status: 302, headers: { location: "http://private.example/" } });
    await expect(safeFetchText("https://example.com/")).rejects.toThrow("blocked address");
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("公開ホストへのリダイレクトは追従し、最終URLを返す", async () => {
    dns.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    serve({ status: 301, headers: { location: "/item/1" } }, { body: "<title>作品</title>" });
    await expect(safeFetchText("https://example.com/")).resolves.toEqual({ url: "https://example.com/item/1", status: 200, text: "<title>作品</title>" });
  });

  it("圧縮された本文を展開して返す", async () => {
    dns.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    serve({ headers: { "content-encoding": "gzip" }, body: gzipSync("商品ページ") });
    await expect(safeFetchText("https://example.com/")).resolves.toMatchObject({ text: "商品ページ" });
  });

  it("本文は上限サイズで打ち切る", async () => {
    dns.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    serve({ body: "a".repeat(2_000_000) });
    const res = await safeFetchText("https://example.com/");
    expect(res.text.length).toBe(1_500_000);
  });
});
