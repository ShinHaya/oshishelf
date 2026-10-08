import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireProfile: vi.fn(), getViewer: vi.fn(), SESSION_COOKIE: "test-session" }));
vi.mock("@/lib/data/account", () => ({}));
vi.mock("@/lib/data/users", () => ({ addShelfCategory: vi.fn(), removeShelfCategory: vi.fn() }));
vi.mock("@/lib/data/items", () => ({ updateItem: vi.fn(), setItemsShelfCategory: vi.fn(), clearShelfCategory: vi.fn() }));
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
import { clearShelfCategory, setItemsShelfCategory } from "@/lib/data/items";
import { addShelfCategory, removeShelfCategory } from "@/lib/data/users";
import { assignShelfCategoryAction, createShelfCategoryAction, deleteShelfCategoryAction, importBulkAction, importPasteAction } from "./actions";

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

  it("drops cards and images with oversized URLs instead of rejecting the whole import", async () => {
    vi.mocked(readPurchaseHistory).mockResolvedValue({ products: [{ url: "https://www.amazon.co.jp/dp/B000000001", title: "架空の購入作品" }], reviewed: 1, excluded: 0, recovered: 0, notes: [] });
    const tracking = "https://www.amazon.co.jp/sspa/click?" + "x".repeat(2100);
    const card = (href: string, src: string) => ({ href, text: "架空の購入作品", context: "", section: "注文日", imgs: [{ src, alt: "" }], page: 1 });
    const owned = card("https://www.amazon.co.jp/dp/B000000001", tracking);
    const result = await importBulkAction({ page: "https://www.amazon.co.jp/your-orders/orders", cards: [owned, card(tracking, "https://m.media-amazon.com/images/I/fictional.jpg")] });
    expect(result.ok).toBe(true);
    expect(readPurchaseHistory).toHaveBeenCalledWith([{ ...owned, imgs: [] }], "https://www.amazon.co.jp/your-orders/orders", "", 150);
  });

  it("still requires authentication before reading or importing history", async () => {
    vi.mocked(requireProfile).mockRejectedValueOnce(new Error("authentication required"));
    await expect(importBulkAction({ page: "https://shop.example/orders", cards: [] })).rejects.toThrow("authentication required");
    expect(readPurchaseHistory).not.toHaveBeenCalled();
    expect(importCandidates).not.toHaveBeenCalled();
  });
});

describe("custom shelf categories", () => {
  it("creates a trimmed category for the authenticated owner", async () => {
    expect(await createShelfCategoryAction("  積読  ")).toEqual({ ok: true, data: "積読" });
    expect(addShelfCategory).toHaveBeenCalledWith("fictional-owner", "積読");
  });

  it("rejects empty or oversized category names", async () => {
    expect((await createShelfCategoryAction("   ")).ok).toBe(false);
    expect((await createShelfCategoryAction("あ".repeat(41))).ok).toBe(false);
    expect((await assignShelfCategoryAction(["fictional-item"], "   ")).ok).toBe(false);
    expect(addShelfCategory).not.toHaveBeenCalled();
    expect(setItemsShelfCategory).not.toHaveBeenCalled();
  });

  it("adds every selected item to the same category using the authenticated owner", async () => {
    vi.mocked(setItemsShelfCategory).mockResolvedValueOnce(2);
    expect(await assignShelfCategoryAction(["fictional-a", "fictional-b"], "お気に入り")).toEqual({ ok: true, data: 2 });
    expect(addShelfCategory).toHaveBeenCalledWith("fictional-owner", "お気に入り");
    expect(setItemsShelfCategory).toHaveBeenCalledWith("fictional-owner", ["fictional-a", "fictional-b"], "お気に入り");
  });

  it("removes selected items from their category without registering one", async () => {
    await assignShelfCategoryAction(["fictional-a"], null);
    expect(addShelfCategory).not.toHaveBeenCalled();
    expect(setItemsShelfCategory).toHaveBeenCalledWith("fictional-owner", ["fictional-a"], null);
  });

  it("does not assign items when the category limit is reached", async () => {
    vi.mocked(addShelfCategory).mockRejectedValueOnce(new Error("カテゴリーは50個までです"));
    expect(await assignShelfCategoryAction(["fictional-a"], "新しいカテゴリー")).toEqual({ ok: false, error: "カテゴリーは50個までです" });
    expect(setItemsShelfCategory).not.toHaveBeenCalled();
  });

  it("rejects invalid document paths and oversized selections", async () => {
    expect((await assignShelfCategoryAction(["other/item"], "積読")).ok).toBe(false);
    expect((await assignShelfCategoryAction(Array.from({ length: 501 }, (_, i) => `item-${i}`), "積読")).ok).toBe(false);
    expect(setItemsShelfCategory).not.toHaveBeenCalled();
  });

  it("deletes a category by taking it off the owner's items", async () => {
    vi.mocked(clearShelfCategory).mockResolvedValueOnce(3);
    expect(await deleteShelfCategoryAction("積読")).toEqual({ ok: true, data: 3 });
    expect(clearShelfCategory).toHaveBeenCalledWith("fictional-owner", "積読");
    expect(removeShelfCategory).toHaveBeenCalledWith("fictional-owner", "積読");
  });

  it("requires authentication before writing", async () => {
    vi.mocked(requireProfile).mockRejectedValue(new Error("authentication required"));
    await expect(createShelfCategoryAction("積読")).rejects.toThrow("authentication required");
    await expect(assignShelfCategoryAction(["fictional-item"], "積読")).rejects.toThrow("authentication required");
    await expect(deleteShelfCategoryAction("積読")).rejects.toThrow("authentication required");
    expect(addShelfCategory).not.toHaveBeenCalled();
    expect(setItemsShelfCategory).not.toHaveBeenCalled();
    expect(clearShelfCategory).not.toHaveBeenCalled();
  });
});
