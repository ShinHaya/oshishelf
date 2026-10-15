import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./safe-fetch", () => ({ safeFetchText: vi.fn() }));
vi.mock("./product-meta", () => ({ fetchProductMeta: vi.fn() }));
import { safeFetchText } from "./safe-fetch";
import { fetchProductMeta } from "./product-meta";
import { findRecommendationProducts, recommendationShops } from "./recommendation-products";

beforeEach(() => vi.resetAllMocks());

it("separates adult and mainstream stores and deduplicates import history", () => {
  const used = ["amazon", "rakuten", "fanza", "dlsite", "amazon", "unknown"];
  expect(recommendationShops(used, "fanza", true)).toEqual(["fanza", "dlsite"]);
  expect(recommendationShops(used, "amazon", false)).toEqual(["amazon", "rakuten"]);
  expect(recommendationShops(used, "dlsite", false)).toEqual(["fanza", "dlsite"]);
  expect(recommendationShops([], "amazon", false)).toEqual([]);
});

it("uses verified product pages rather than search links or invented URLs", async () => {
  vi.mocked(safeFetchText).mockResolvedValue({ status: 200, url: "https://www.amazon.co.jp/s?k=fiction", text: '<a href="https://evil.example/dp/B012345678">bad</a><a href="/s?k=fiction">search</a><a href="/dp/B012345678?tag=tracking">product</a>' });
  vi.mocked(fetchProductMeta).mockResolvedValue({ title: "架空の作品", price: null, imageUrl: null, description: null });
  expect(await findRecommendationProducts("架空の作品", ["amazon"], false)).toEqual([{ shop: "amazon", label: "Amazon", url: "https://www.amazon.co.jp/dp/B012345678" }]);
  expect(fetchProductMeta).toHaveBeenCalledTimes(1);
});

it("rejects unrelated products and login walls", async () => {
  vi.mocked(safeFetchText).mockResolvedValue({ status: 200, url: "https://www.amazon.co.jp/s?k=fiction", text: '<a href="/dp/B012345678">product</a>' });
  vi.mocked(fetchProductMeta).mockResolvedValue({ title: "架空の作品 2", price: null, imageUrl: null, description: null });
  expect(await findRecommendationProducts("架空の作品", ["amazon"], false)).toEqual([]);
  vi.mocked(fetchProductMeta).mockResolvedValue({ title: "架空の作品", loginWall: true, price: null, imageUrl: null, description: null });
  expect(await findRecommendationProducts("架空の作品", ["amazon"], false)).toEqual([]);
});

it("keeps checking all used shops when one store blocks fetching", async () => {
  vi.mocked(safeFetchText).mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce({ status: 200, url: "https://books.rakuten.co.jp/search?sitem=fiction", text: '<a href="/rb/123456/">product</a>' });
  vi.mocked(fetchProductMeta).mockResolvedValue({ title: "架空の作品", price: null, imageUrl: null, description: null });
  expect(await findRecommendationProducts("架空の作品", ["amazon", "rakuten"], false)).toEqual([{ shop: "rakuten", label: "楽天", url: "https://books.rakuten.co.jp/rb/123456/" }]);
});


it("does not search game-only stores for books or book-only stores for games", () => {
  expect(recommendationShops(["amazon", "steam", "bookwalker"], "amazon", false, "book")).toEqual(["amazon", "bookwalker"]);
  expect(recommendationShops(["amazon", "steam", "bookwalker"], "steam", false, "game")).toEqual(["amazon", "steam"]);
});

it("searches the adult DLsite catalogue without sending the title to a model", async () => {
  vi.mocked(safeFetchText).mockResolvedValue({ status: 200, url: "https://www.dlsite.com/maniax/fsr/", text: '<a href="/maniax/work/=/product_id/RJ123456.html">product</a>' });
  vi.mocked(fetchProductMeta).mockResolvedValue({ title: "架空の作品", price: null, imageUrl: null, description: null });
  expect(await findRecommendationProducts("架空の作品", ["dlsite"], true)).toHaveLength(1);
  expect(safeFetchText).toHaveBeenCalledWith(expect.stringContaining("/maniax/fsr/"), { cookie: "adultchecked=1" });
});

it("returns a verified product link for each matching EC store", async () => {
  vi.mocked(safeFetchText)
    .mockResolvedValueOnce({ status: 200, url: "https://www.amazon.co.jp/s?k=fiction", text: '<a href="/dp/B012345678">product</a>' })
    .mockResolvedValueOnce({ status: 200, url: "https://books.rakuten.co.jp/search?sitem=fiction", text: '<a href="/rb/123456/">product</a>' });
  vi.mocked(fetchProductMeta).mockResolvedValue({ title: "架空の作品", price: null, imageUrl: null, description: null });
  expect(await findRecommendationProducts("架空の作品", ["amazon", "rakuten"], false)).toEqual([
    { shop: "amazon", label: "Amazon", url: "https://www.amazon.co.jp/dp/B012345678" },
    { shop: "rakuten", label: "楽天", url: "https://books.rakuten.co.jp/rb/123456/" },
  ]);
});
