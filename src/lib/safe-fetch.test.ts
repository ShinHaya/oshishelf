import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { lookup } from "node:dns/promises";
import { safeFetchText } from "./safe-fetch";

const dns = vi.mocked(lookup);

afterEach(() => vi.unstubAllGlobals());

describe("外部URLの取得境界", () => {
  it.each([
    ["file:///etc/passwd", "unsupported protocol"],
    ["https://user:password@example.com/", "credentials in url"],
    ["http://metadata.google.internal/", "blocked host"],
  ])("%s は取得前に拒否する", async (url, message) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetchText(url)).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"])(
    "DNSが内部IP %s を返した場合は取得しない", async (address) => {
      dns.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }] as never);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(safeFetchText("https://example.com/")).rejects.toThrow("blocked address");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("公開IPと内部IPが混在するホストも拒否する", async () => {
    dns.mockResolvedValue([{ address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 }] as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetchText("https://example.com/")).rejects.toThrow("blocked address");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("公開ホストから内部IPへのリダイレクトも再検証する", async () => {
    dns.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: "http://private.example/" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetchText("https://example.com/")).rejects.toThrow("blocked address");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("公開URLの本文とステータスを返し、自動リダイレクトを無効にする", async () => {
    dns.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response("商品ページ"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetchText("https://example.com/")).resolves.toEqual({
      url: "https://example.com/", status: 200, text: "商品ページ",
    });
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://example.com/"),
      expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }));
  });
});
