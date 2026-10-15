import { describe, expect, it } from "vitest";
import { makeItem } from "./test-fixtures";
import { filterShelf, INITIAL_SHELF_FILTERS } from "./shelf-filters";

const items = [
  makeItem({ id: "comic", title: "星の旅", category: "comic", shelfCategory: "お気に入り", tags: ["冒険"], shop: "shop-a", publishedAt: 20 }),
  makeItem({ id: "book", title: "朝の物語", category: "book", tags: ["冒険"], shop: "shop-b", publishedAt: 30 }),
  makeItem({ id: "game", title: "海の旅", category: "game", shelfCategory: "お気に入り", tags: ["パズル"], shop: "shop-a", publishedAt: 10 }),
];
const ids = (filters: Partial<typeof INITIAL_SHELF_FILTERS>, own = true) => filterShelf(items, { ...INITIAL_SHELF_FILTERS, ...filters }, own).map((i) => i.id);

describe("棚の絞り込みと並べ替え", () => {
  it("独自カテゴリー付きの作品も標準カテゴリーで絞り込む", () => {
    expect(ids({ category: "default:comic" }, false)).toEqual(["comic"]);
  });
  it("独自カテゴリー・ジャンル・購入サイトをANDで絞り込む", () => {
    expect(ids({ category: "custom:お気に入り", genre: "冒険", shop: "shop-a" })).toEqual(["comic"]);
    expect(ids({ category: "default:book", shop: "shop-a" })).toEqual([]);
  });
  it("独自カテゴリーは本人の棚だけで使用できる", () => {
    expect(ids({ category: "custom:お気に入り" })).toEqual(["comic", "game"]);
    expect(ids({ category: "custom:お気に入り" }, false)).toEqual([]);
  });
  it("全件表示へ戻せる", () => {
    expect(ids({})).toEqual(["book", "comic", "game"]);
  });
  it("作品を公開日時・作品名・カテゴリー名で並べ替え、入力を変更しない", () => {
    expect(ids({ sort: "oldest" })).toEqual(["game", "comic", "book"]);
    expect(ids({ sort: "title" })).toEqual([...items].sort((a, b) => a.title.localeCompare(b.title, "ja")).map((i) => i.id));
    expect(ids({ sort: "category" })).toEqual(["game", "comic", "book"]);
    expect(items.map((i) => i.id)).toEqual(["comic", "book", "game"]);
  });
});
