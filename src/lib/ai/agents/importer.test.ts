import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../gemini", () => ({ generateJson: vi.fn(), LITE_MODEL: "test-model" }));
vi.mock("../../product-meta", () => ({ fetchProductMeta: vi.fn(), readProductWithGemini: vi.fn() }));
vi.mock("../../data/items", () => ({ createDrafts: vi.fn() }));
vi.mock("./guard", () => ({ runPrivacyGuard: vi.fn() }));
import { generateJson } from "../gemini";
import { extractFromScreenshot, extractFromText } from "./importer";

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
