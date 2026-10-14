import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../gemini", () => ({ generateJson: vi.fn(), LITE_MODEL: "test-model" }));
vi.mock("../../product-meta", () => ({ fetchProductMeta: vi.fn(), readProductWithGemini: vi.fn() }));
vi.mock("../../data/social", () => ({ consumeQuota: vi.fn() }));
vi.mock("../../data/items", () => ({ createDrafts: vi.fn() }));
vi.mock("./guard", () => ({ runPrivacyGuard: vi.fn() }));
import { generateJson } from "../gemini";
import { consumeQuota } from "../../data/social";
import { fetchProductMeta, readProductWithGemini } from "../../product-meta";
import { createDrafts } from "../../data/items";
import { importCandidates, MAX_GEMINI_FALLBACKS_PER_IMPORT, extractFromScreenshot, extractFromText } from "./importer";

const model = vi.mocked(generateJson);
beforeEach(() => { model.mockReset(); });

describe("purchase evidence for pasted text and screenshots", () => {
  it("drops model-selected items with no purchase evidence or recommendation evidence", async () => {
    model.mockResolvedValue({ items: [
      { title: "架空の購入作品", shop: "Amazon", purchaseEvidence: "注文日" },
      { title: "架空のおすすめ作品", shop: "Amazon", purchaseEvidence: "あなたが購入した作品からのおすすめ" },
      { title: "根拠なしの作品", shop: "Amazon" },
      { title: "商品URLだけの作品", shop: "Amazon", purchaseEvidence: "https://www.amazon.co.jp/dp/B000000001" },
    ] });
    const result = await extractFromText("注文日 2026年1月2日 架空の購入作品 あなたが購入した作品からのおすすめ 架空のおすすめ作品");
    expect(result.map(c => c.title)).toEqual(["架空の購入作品"]);
  });

  it("requires evidence and product URLs to exist in the actual input", async () => {
    model.mockResolvedValue({ items: [
      { title: "架空の本", shop: "Amazon", purchaseEvidence: "注文日", url: "https://www.amazon.co.jp/dp/B000000001" },
      { title: "架空のゲーム", shop: "Amazon", purchaseEvidence: "注文日", url: "https://www.amazon.co.jp/dp/B000000002" },
      { title: "存在しない根拠", shop: "Amazon", purchaseEvidence: "配達済み" },
    ] });
    const result = await extractFromText("注文日 2026年1月2日 架空の本 https://www.amazon.co.jp/dp/B000000001 架空のゲーム");
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe("https://www.amazon.co.jp/dp/B000000001");
    expect(result[1].urlIsSearch).toBe(true);
  });

  it("uses search links rather than model-invented screenshot URLs", async () => {
    model.mockResolvedValue({ items: [
      { title: "架空の本", shop: "Amazon", purchaseEvidence: "購入済み", url: "https://www.amazon.co.jp/dp/B000000001" },
      { title: "架空のおすすめ", shop: "Amazon", purchaseEvidence: "もう一度買う" },
    ] });
    const result = await extractFromScreenshot("fake-image", "image/png");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: "架空の本", urlIsSearch: true });
  });
});


describe("import work budgets", () => {
  const candidates = Array.from({ length: 30 }, (_, i) => ({ url: `https://www.amazon.co.jp/dp/B${String(i).padStart(9, "0")}`, title: "" }));
  beforeEach(() => {
    vi.mocked(consumeQuota).mockReset();
    vi.mocked(fetchProductMeta).mockReset();
    vi.mocked(readProductWithGemini).mockReset();
    vi.mocked(createDrafts).mockReset();
    vi.mocked(fetchProductMeta).mockResolvedValue({ title: null, imageUrl: null, price: null, description: null });
    vi.mocked(readProductWithGemini).mockRejectedValue(new Error("blocked"));
    vi.mocked(createDrafts).mockResolvedValue([]);
    model.mockResolvedValue({ items: [] });
  });
  it("charges all candidates before fetching and caps parallel fallback attempts, including failures", async () => {
    await importCandidates("fictional-owner", candidates, "url", "private");
    expect(consumeQuota).toHaveBeenNthCalledWith(1, "fictional-owner", "import", 30);
    expect(fetchProductMeta).toHaveBeenCalledTimes(30);
    expect(readProductWithGemini).toHaveBeenCalledTimes(MAX_GEMINI_FALLBACKS_PER_IMPORT);
    expect(consumeQuota).toHaveBeenCalledTimes(1 + MAX_GEMINI_FALLBACKS_PER_IMPORT);
  });
  it("does no external work or writes when the candidate reservation fails", async () => {
    vi.mocked(consumeQuota).mockRejectedValueOnce(new Error("quota"));
    await expect(importCandidates("fictional-owner", candidates, "bulk", "private")).rejects.toThrow("quota");
    expect(fetchProductMeta).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(createDrafts).not.toHaveBeenCalled();
  });
  it("does not call Gemini when the fallback daily budget is exhausted", async () => {
    vi.mocked(consumeQuota).mockImplementation(async (_, kind) => { if (kind === "importFallback") throw new Error("quota"); });
    await importCandidates("fictional-owner", candidates, "url", "private");
    expect(readProductWithGemini).not.toHaveBeenCalled();
  });
  it("charges only the bounded candidate list and skips empty input", async () => {
    await importCandidates("fictional-owner", [], "paste", "private");
    expect(consumeQuota).not.toHaveBeenCalled();
    await importCandidates("fictional-owner", Array.from({ length: 151 }, () => ({ url: "https://example.com/search", title: "架空", urlIsSearch: true })), "paste", "private");
    expect(consumeQuota).toHaveBeenCalledWith("fictional-owner", "import", 150);
    expect(fetchProductMeta).not.toHaveBeenCalled();
  });
});


describe("candidate URL validation before external work", () => {
  it.each(["javascript:alert(1)", "data:text/html,fictional", "https://user:pass@shop.example/product"])("rejects %s before fetching or reserving quota", async (url) => {
    vi.mocked(consumeQuota).mockClear();
    vi.mocked(fetchProductMeta).mockClear();
    vi.mocked(createDrafts).mockClear();
    await expect(importCandidates("fictional-owner", [{ url, title: "架空" }], "bulk", "private")).rejects.toThrow("HTTP(S)");
    expect(consumeQuota).not.toHaveBeenCalled();
    expect(fetchProductMeta).not.toHaveBeenCalled();
    expect(createDrafts).not.toHaveBeenCalled();
  });
});
