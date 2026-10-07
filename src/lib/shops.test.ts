import { describe, expect, it } from "vitest";
import { canonicalizeUrl, detectShop, looksLikeProductUrl } from "./shops";

describe("商品URLの判定と重複排除", () => {
  it.each([
    ["https://www.amazon.co.jp/gp/product/B012345678?tag=tracking", "amazon:B012345678", false],
    ["https://www.dlsite.com/maniax/work/=/product_id/RJ123456.html", "dlsite:RJ123456", true],
    ["https://www.dlsite.com/home/work/=/product_id/RJ123456.html", "dlsite:RJ123456", false],
    ["https://video.dmm.co.jp/av/content/?id=ABC00123", "fanza:abc00123", true],
    ["https://store.steampowered.com/app/12345/title/", "steam:12345", false],
  ])("%s の商品キーと成人向け区分", (url, productKey, adult) => {
    expect(detectShop(url)).toMatchObject({ productKey, adult });
    expect(looksLikeProductUrl(url)).toBe(true);
  });

  it("DMM Booksのシリーズ一覧を商品として取り込まない", () => {
    const url = "https://book.dmm.co.jp/product/123/volumes/?cid=tracking";
    expect(looksLikeProductUrl(url)).toBe(false);
    expect(detectShop(url).productKey).toBeNull();
  });

  it("試し読みと商品本体を同じURLにまとめる", () => {
    expect(canonicalizeUrl("https://book.dmm.co.jp/product/123/abc001/tachiyomi/?cid=tracking"))
      .toBe("https://book.dmm.co.jp/product/123/abc001/");
  });

  it("Amazonの追跡パラメータと商品名に依存しない", () => {
    expect(canonicalizeUrl("https://www.amazon.co.jp/title/dp/B012345678?tag=tracking#reviews"))
      .toBe("https://www.amazon.co.jp/dp/B012345678");
  });

  it("未知のショップでも商品識別用のクエリは保持する", () => {
    expect(canonicalizeUrl("https://example.com/product?id=123&utm_source=test#detail"))
      .toBe("https://example.com/product?id=123");
  });

  it("不正URLは商品候補から除外する", () => {
    expect(looksLikeProductUrl("invalid")).toBe(false);
    expect(detectShop("invalid").shop).toBe("unknown");
  });
});
