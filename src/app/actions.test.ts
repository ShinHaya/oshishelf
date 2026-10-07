import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireProfile: vi.fn(), getViewer: vi.fn(), SESSION_COOKIE: "test-session" }));
vi.mock("@/lib/data/account", () => ({}));
vi.mock("@/lib/data/users", () => ({}));
vi.mock("@/lib/data/items", () => ({}));
vi.mock("@/lib/data/reviews", () => ({}));
vi.mock("@/lib/data/social", () => ({ consumeQuota: vi.fn() }));
vi.mock("@/lib/ai/agents/importer", () => ({ extractFromText: vi.fn(), extractFromScreenshot: vi.fn(), importCandidates: vi.fn(), MAX_ITEMS_PER_IMPORT: 150 }));
vi.mock("@/lib/ai/agents/history-reader", () => ({ readPurchaseHistory: vi.fn() }));
vi.mock("@/lib/ai/agents/profiler", () => ({}));
vi.mock("@/lib/ai/agents/matcher", () => ({}));
vi.mock("@/lib/ai/agents/twin", () => ({}));
vi.mock("@/lib/ai/agents/watcher", () => ({}));
vi.mock("@/lib/ai/agents/guard", () => ({}));
import { requireProfile } from "@/lib/session";
import { consumeQuota } from "@/lib/data/social";
import { extractFromText, importCandidates } from "@/lib/ai/agents/importer";
import { readPurchaseHistory } from "@/lib/ai/agents/history-reader";
import { importBulkAction, importPasteAction } from "./actions";

beforeEach(() => {
  vi.mocked(requireProfile).mockResolvedValue({ uid: "fictional-owner", profile: { defaultVisibility: "private" } } as Awaited<ReturnType<typeof requireProfile>>);
  vi.mocked(importCandidates).mockResolvedValue({ created: 1, skipped: 0, flagged: 0 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const paste = (text: string) => { const form = new FormData(); form.set("text", text); return importPasteAction(null, form); };

describe("purchase-history action boundaries", () => {
  it("does not bypass purchase classification when pasted text has three product URLs", async () => {
    const owned = { url: "https://www.amazon.co.jp/dp/B000000001", title: "架空の購入作品" };
    vi.mocked(extractFromText).mockResolvedValue([owned]);
    const text = "注文履歴 https://www.amazon.co.jp/dp/B000000001 おすすめ https://www.amazon.co.jp/dp/B000000002 https://www.amazon.co.jp/dp/B000000003";
    expect((await paste(text)).ok).toBe(true);
    expect(extractFromText).toHaveBeenCalledWith(text);
    expect(importCandidates).toHaveBeenCalledWith("fictional-owner", [owned], "paste", "private");
    expect(consumeQuota).toHaveBeenCalledWith("fictional-owner", "import");
  });

  it("rejects adult-shop pasted URLs instead of treating them as purchases or sending titles to AI", async () => {
    const result = await paste("FANZA 購入済み作品 架空の作品 https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_123456/");
    expect(result.ok).toBe(false);
    expect(extractFromText).not.toHaveBeenCalled();
    expect(importCandidates).not.toHaveBeenCalled();
  });

  it("does not restore excluded bulk cards through a full-page text fallback", async () => {
    vi.mocked(readPurchaseHistory).mockResolvedValue({ products: [], reviewed: 1, excluded: 1, recovered: 0, notes: [] });
    const result = await importBulkAction({ page: "https://shop.example/orders", cards: [], text: "おすすめ 架空の作品", title: "注文履歴" });
    expect(result.ok).toBe(false);
    expect(extractFromText).not.toHaveBeenCalled();
    expect(importCandidates).not.toHaveBeenCalled();
  });

  it("still requires authentication before reading or importing history", async () => {
    vi.mocked(requireProfile).mockRejectedValueOnce(new Error("authentication required"));
    await expect(importBulkAction({ page: "https://shop.example/orders", cards: [] })).rejects.toThrow("authentication required");
    expect(readPurchaseHistory).not.toHaveBeenCalled();
    expect(importCandidates).not.toHaveBeenCalled();
  });
});
