import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../gemini", () => ({ generateJson: vi.fn() }));
vi.mock("../../product-meta", () => ({ largeDmmImage: (url: string | null) => url }));
import { generateJson } from "../gemini";
import { readPurchaseHistory, type PageCard } from "./history-reader";

const model = vi.mocked(generateJson);
const card = (href: string, section = "", text = "架空の作品", image = "https://images.example/fiction.jpg"): PageCard => ({
  href, section, text, context: text, imgs: [{ src: image, alt: text }], page: 1,
});
const read = (cards: PageCard[], page = "https://www.amazon.co.jp/your-orders/orders") => readPurchaseHistory(cards, page, "購入履歴", 100);
const amazon = (id: number) => `https://www.amazon.co.jp/dp/B00000000${id}`;

beforeEach(() => { model.mockReset(); });

describe("grounded purchase-history reading", () => {
  it("imports owned FANZA video cards without links locally, with a search link", async () => {
    const result = await read([card("", "購入済み商品", "架空の動画"), card("https://video.dmm.co.jp/av/content/?id=fiction002", "あなたと好みが似た人が見ている商品")], "https://video.dmm.co.jp/mylibrary/");
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({ title: "架空の動画", urlIsSearch: true, shopHint: "fanza" });
    expect(model).not.toHaveBeenCalled();
  });

  it("reads FANZA doujin owned detail links and maps them to public product URLs", async () => {
    const result = await read([card("https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=d_123456/", "購入済み作品"), card("https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_654321/", "売れ筋ランキング"), card("https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_999999/", "あなたが購入した作品からのおすすめ")], "https://www.dmm.co.jp/dc/-/mylibrary/");
    expect(result.products.map(c => c.url)).toEqual(["https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_123456/"]);
    expect(model).not.toHaveBeenCalled();
  });

  it("rejects recommendation indices even when AI returns them", async () => {
    model.mockResolvedValue({ products: [0, 1, 2, 3].map(link => ({ link, title: "架空の作品" })) });
    const result = await read([card(amazon(1), "注文履歴"), card(amazon(2), "もう一度買う"), card(amazon(3), "次に読むものを見つけよう"), card(amazon(4))]);
    expect(result.products.map(c => c.url)).toEqual([amazon(1)]);
    const prompt = JSON.stringify(model.mock.calls);
    expect(prompt).not.toContain(amazon(2));
    expect(prompt).not.toContain(amazon(3));
  });

  it("on AI failure imports only cards with ownership evidence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    model.mockRejectedValue(new Error("test unavailable"));
    const result = await read([card(amazon(1), "注文履歴"), card(amazon(2)), card(amazon(3), "おすすめ")]);
    expect(result.products.map(c => c.url)).toEqual([amazon(1)]);
  });

  it("does not import navigation banners in an adult purchase section", async () => {
    const result = await read([card("https://dlsoft.dmm.co.jp/mylibrary/", "購入済み商品", "PCソフトのライブラリ"), card("https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=d_123456/", "購入済み作品")], "https://www.dmm.co.jp/dc/-/mylibrary/");
    expect(result.products).toHaveLength(1);
    expect(result.products[0].url).toContain("cid=d_123456");
    expect(model).not.toHaveBeenCalled();
  });

  it("does not infer ownership from the history page title or product URL", async () => {
    const result = await read([card(amazon(1))]);
    expect(result.products).toEqual([]);
    expect(model).not.toHaveBeenCalled();
  });

  it("does not treat purchase words inside a product title as proof", async () => {
    const result = await read([card(amazon(1), "", "購入済みの世界"), card(amazon(2), "", "Owned Dreams")]);
    expect(result.products).toEqual([]);
    expect(model).not.toHaveBeenCalled();
  });

  it("preserves a purchase when its recommendation occurrence appears first", async () => {
    model.mockResolvedValue({ products: [{ link: 1, title: "購入作品", image: 0 }] });
    const result = await read([card(amazon(1), "おすすめ", "推奨商品", "https://images.example/recommend.jpg"), card(amazon(1), "注文履歴", "購入作品", "https://images.example/owned.jpg")]);
    expect(result.products).toMatchObject([{ title: "購入作品", imageUrl: "https://images.example/owned.jpg" }]);
  });

  it("keeps order products with a buy-again button while rejecting the buy-again section", async () => {
    model.mockResolvedValue({ products: [{ link: 0, title: "架空の本" }] });
    const owned = card(amazon(1));
    owned.context = "架空の本 注文日 2026年1月2日 もう一度買う";
    const result = await read([owned, card(amazon(2), "もう一度買う")]);
    expect(result.products.map(c => c.url)).toEqual([amazon(1)]);
  });

  it("supports unknown shops and distinct products carried in query parameters", async () => {
    model.mockResolvedValue({ products: [{ link: 0, title: "Fictional One" }, { link: 1, title: "Fictional Two" }] });
    const result = await read([card("https://shop.example/product?id=1", "Owned games"), card("https://shop.example/product?id=2", "Owned games")], "https://shop.example/library");
    expect(result.products).toHaveLength(2);
  });

  it.each(["購入日", "注文済み", "Bookshelf", "Your Orders"])("accepts site-independent ownership cues: %s", async (section) => {
    model.mockResolvedValue({ products: [{ link: 0, title: "Fictional Product" }] });
    expect((await read([card("https://shop.example/item/1", section)], "https://shop.example/orders")).products).toHaveLength(1);
  });

  it("recall cannot recover unproven or recommendation cards", async () => {
    model.mockResolvedValueOnce({ products: [] }).mockResolvedValueOnce({ products: [0, 1, 2].map(link => ({ link, title: "架空の本" })) });
    const result = await read([card(amazon(1), "注文履歴"), card(amazon(2), "おすすめ"), card(amazon(3))]);
    expect(result.products.map(c => c.url)).toEqual([amazon(1)]);
    expect(result.recovered).toBe(1);
  });

  it("does not let alsoLinks inject another product's image or hide it from recall", async () => {
    model.mockResolvedValueOnce({ products: [{ link: 0, title: "架空の本", alsoLinks: [1, 2, 999], imageLink: 1, image: 0 }] }).mockResolvedValueOnce({ products: [{ link: 1, title: "別の購入作品" }] });
    const result = await read([card(amazon(1), "注文履歴"), card(amazon(2), "注文履歴", "別の購入作品", "https://images.example/other.jpg"), card(amazon(3), "おすすめ")]);
    expect(result.products).toHaveLength(2);
    expect(result.products[0].imageUrl).toBe("https://images.example/fiction.jpg");
  });
});
