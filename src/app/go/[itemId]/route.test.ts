import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeItem, makeProfile } from "@/lib/test-fixtures";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getItem: vi.fn(), getViewer: vi.fn(), isFollowing: vi.fn(), incrementClick: vi.fn() }));
vi.mock("@/lib/session", () => ({ getViewer: mocks.getViewer }));
vi.mock("@/lib/data/items", () => ({ getItem: mocks.getItem, incrementClick: mocks.incrementClick }));
vi.mock("@/lib/data/social", () => ({ isFollowing: mocks.isFollowing }));
import { GET } from "./route";
const run = () => GET(new Request("https://app.example/go/item-1"), { params: Promise.resolve({ itemId: "item-1" }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getViewer.mockResolvedValue(null);
  mocks.isFollowing.mockResolvedValue(false);
  mocks.incrementClick.mockResolvedValue(undefined);
  mocks.getItem.mockResolvedValue(makeItem({ url: "https://www.amazon.co.jp/dp/B000000001" }));
});
describe("outbound purchase links", () => {
  it("redirects a visible item to a real shop", async () => {
    const res = await run();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://www.amazon.co.jp/dp/B000000001");
    expect(mocks.incrementClick).toHaveBeenCalledWith("item-1");
  });
  it.each(["https://shop.example/product/1", "https://fakeamazon.co.jp/dp/B000000001", "https://notbooth.pm/items/123"])("requires an explicit click for %s", async (url) => {
    mocks.getItem.mockResolvedValue(makeItem({ url }));
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain(new URL(url).hostname);
    expect(mocks.incrementClick).not.toHaveBeenCalled();
  });
  it("escapes an unknown destination inside HTML", async () => {
    mocks.getItem.mockResolvedValue(makeItem({ url: 'https://shop.example/product?a="onclick="alert(1)&b=<script>' }));
    const html = await (await run()).text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('%22');
    expect(html).toContain('&amp;');
  });
  it("normalizes noncanonical legacy HTTP URLs before the confirmation click", async () => {
    mocks.getItem.mockResolvedValue(makeItem({ url: "https:shop.example/product" }));
    expect(await (await run()).text()).toContain('href="https://shop.example/product"');
  });
  it.each(["javascript:alert(1)", "data:text/html,fictional", "https://user:pass@shop.example/product"])("rejects dangerous legacy links %s", async (url) => {
    mocks.getItem.mockResolvedValue(makeItem({ url }));
    expect((await run()).status).toBe(404);
  });
  it.each([{ status: "draft" as const }, { visibility: "private" as const }, { visibility: "followers" as const }, { isAdult: true }])("keeps restricted items hidden before showing a destination", async (patch) => {
    mocks.getItem.mockResolvedValue(makeItem({ ...patch, url: "https://shop.example/product/1" }));
    const res = await run();
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("shop.example");
  });
  it("preserves the owner exception for adult drafts", async () => {
    mocks.getViewer.mockResolvedValue({ profile: makeProfile({ uid: "owner" }) });
    mocks.getItem.mockResolvedValue(makeItem({ isAdult: true, status: "draft", visibility: "private", url: "https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_123/" }));
    expect((await run()).status).toBe(302);
    expect(mocks.incrementClick).not.toHaveBeenCalled();
  });
});
