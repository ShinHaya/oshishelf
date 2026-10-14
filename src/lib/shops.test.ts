import { describe, expect, it, vi } from "vitest";
import { canonicalizeUrl, detectShop, looksLikeProductUrl, publicProductUrl, isProductUrl, isKnownShopUrl, withAffiliate } from "./shops";

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

  it("FANZA同人の購入済み詳細と公開商品を同じ作品として扱う", () => {
    const owned = "https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=d_123456/";
    const product = "https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_123456/";
    expect(publicProductUrl(owned)).toBe(product);
    expect(detectShop(owned).productKey).toBe(detectShop(product).productKey);
    expect(publicProductUrl("https://shop.example/dc/-/mylibrary/detail/=/product_id=d_123456/")).toBeNull();
  });

  it("未知のショップでクエリ内の商品IDが違う作品を重複扱いしない", () => {
    expect(detectShop("https://shop.example/product?id=1").productKey)
      .not.toBe(detectShop("https://shop.example/product?id=2").productKey);
  });

  it("不正URLは商品候補から除外する", () => {
    expect(looksLikeProductUrl("invalid")).toBe(false);
    expect(detectShop("invalid").shop).toBe("unknown");
  });
});

describe("偽ドメインを正規ショップにしない", () => {
  it.each([
    ["https://evildlsite.com/home/work/=/product_id/RJ123456.html", "dlsite"],
    ["https://fakedmm.com/detail/=/cid=abc001/", "dmm"],
    ["https://fakedmm.co.jp/detail/=/cid=abc001/", "fanza"],
    ["https://notbooth.pm/items/12345", "booth"],
    ["https://fakerakuten.co.jp/rb/12345/", "rakuten"],
    ["https://fakebookwalker.jp/de12345678-1234-1234-1234/", "bookwalker"],
    ["https://faketoranoana.jp/tora_r/123456/", "toranoana"],
    ["https://fakeamazon.co.jp/dp/B000000001", "amazon"],
    ["https://dlsite.com.evil.example/product_id/RJ123456.html", "dlsite"],
  ])("%s に正規ショップラベルやアフィリエイトを付けない", (url, shop) => {
    vi.stubEnv("AFFILIATE_DMM_ID", "fictional-id");
    vi.stubEnv("AFFILIATE_AMAZON_TAG", "fictional-tag");
    expect(detectShop(url).shop).not.toBe(shop);
    expect(looksLikeProductUrl(url)).toBe(false);
    expect(isKnownShopUrl(url)).toBe(false);
    expect(withAffiliate(url)).toBe(url);
    vi.unstubAllEnvs();
  });
  it.each(["https://book.dmm.co.jp/product/123/abc001/", "https://books.rakuten.co.jp/rb/12345/", "https://sub.booth.pm/items/12345", "https://www.amazon.co.jp/dp/B000000001"])("正規サブドメイン %s を維持する", (url) => {
    expect(isKnownShopUrl(url)).toBe(true);
    expect(looksLikeProductUrl(url)).toBe(true);
  });
  it.each(["javascript:alert(1)", "data:text/html,x", "ftp://www.amazon.co.jp/dp/B000000001", "/relative", "https://user:pass@www.amazon.co.jp/dp/B000000001"])("危険な商品URL %s を拒否する", (url) => {
    expect(isProductUrl(url)).toBe(false);
    expect(isKnownShopUrl(url)).toBe(false);
    expect(looksLikeProductUrl(url)).toBe(false);
  });
  it("未知ショップは保存できるが確認画面を要求する", () => {
    expect(isProductUrl("https://shop.example/product/fictional")).toBe(true);
    expect(isKnownShopUrl("https://shop.example/product/fictional")).toBe(false);
    expect(isKnownShopUrl("https://www.amazon.co.jp:8443/dp/B000000001")).toBe(false);
  });
});
