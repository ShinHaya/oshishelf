import { describe, expect, it } from "vitest";
import { adultAiAllowed, aiItems, aiSafeItems, canSeeAdult, canSeeItem, canWishItem, resolveWishes } from "./access";
import type { Item, Wish } from "./types";
import { makeItem, makeProfile } from "./test-fixtures";

describe("公開範囲", () => {
  it.each(["draft", "published"] as const)("所有者は%sの商品を公開範囲に関係なく読める", (status) => {
    for (const visibility of ["public", "followers", "private"] as const) {
      expect(canSeeItem(makeItem({ status, visibility }), {
        viewerUid: "owner", viewerProfile: null, following: false,
      })).toBe(true);
    }
  });

  it.each([null, "viewer"])("非所有者 %s は下書きと非公開商品を読めない", (viewerUid) => {
    const ctx = { viewerUid, viewerProfile: null, following: true };
    expect(canSeeItem(makeItem({ status: "draft" }), ctx)).toBe(false);
    expect(canSeeItem(makeItem({ visibility: "private" }), ctx)).toBe(false);
    expect(canSeeItem(makeItem(), ctx)).toBe(true);
  });

  it.each([false, true])("フォロワー限定はフォロー状態 %s で判定する", (following) => {
    expect(canSeeItem(makeItem({ visibility: "followers" }), {
      viewerUid: "viewer", viewerProfile: null, following,
    })).toBe(following);
  });
});

describe("成人向け表示とAIへの入力", () => {
  it("未ログインでは成人向け作品を表示しない", () => {
    expect(canSeeAdult(null)).toBe(false);
  });

  it.each([false, true])("成人申告 %s と表示同意の両方を要求する", (isAdult) => {
    for (const showAdult of [false, true]) {
      expect(canSeeAdult(makeProfile({ isAdult, showAdult }))).toBe(isAdult && showAdult);
    }
  });

  it("AIは全体公開済みの作品だけを読み、成人向けは初期状態で除外する", () => {
    const publicItem = makeItem();
    const items = [publicItem, makeItem({ status: "draft" }),
      makeItem({ visibility: "followers" }), makeItem({ visibility: "private" }),
      makeItem({ isAdult: true })];
    expect(aiSafeItems(items)).toEqual([publicItem]);
    expect(aiItems(items, true)).toHaveLength(2);
  });

  it("成人向けのタイトル、画像、URL、メモを消し、元データは変更しない", () => {
    const item = makeItem({ isAdult: true });
    const original = structuredClone(item);
    const [redacted] = aiItems([item], true);
    expect(redacted).toMatchObject({ title: "成人向け作品（Example・書籍）",
      imageUrl: null, url: "", note: "", tags: ["SF"] });
    expect(item).toEqual(original);
  });

  it("所有者と閲覧者の成人申告および各同意が揃った場合だけ成人向けAIを許可する", () => {
    for (const isAdult of [false, true]) {
      for (const aiUseAdult of [false, true]) {
        for (const viewerAdult of [false, true]) {
          for (const showAdult of [false, true]) {
            expect(adultAiAllowed(makeProfile({ isAdult, aiUseAdult }),
              makeProfile({ isAdult: viewerAdult, showAdult })))
              .toBe(isAdult && aiUseAdult && viewerAdult && showAdult);
          }
        }
      }
    }
    expect(adultAiAllowed(makeProfile({ isAdult: true, aiUseAdult: true }), null)).toBe(false);
  });
});

describe("ほしいリストの再判定", () => {
  const wish = (itemId: string): Wish => ({
    itemId, ownerUid: "owner", url: "https://old.example/", title: "保存時のタイトル", imageUrl: null,
    shop: "example", shopLabel: "Example", lastPrice: 1000, watch: true, createdAt: 1, lastCheckedAt: null,
  });
  const viewer = { uid: "viewer", profile: makeProfile() };
  const resolve = (items: Item[], following = new Set<string>(), v = viewer) =>
    resolveWishes(items.map((i) => wish(i.id)), new Map(items.map((i) => [i.id, i])), v, following);

  it("公開中の作品は現在のタイトル・URL・画像で表示する", () => {
    const item = makeItem({ title: "現在のタイトル", url: "https://shop.example/1" });
    const { visible } = resolve([item]);
    expect(visible).toEqual([expect.objectContaining({ itemId: item.id, title: "現在のタイトル", url: "https://shop.example/1", imageUrl: item.imageUrl })]);
  });

  it.each([
    ["非公開", { visibility: "private" }],
    ["下書きに戻した", { status: "draft" }],
    ["商品情報が未取得", { title: "https://shop.example/library" }],
  ] as const)("%s の作品は表示せず、保存したコピーを削除対象にする", (_, overrides) => {
    const { visible, gone } = resolve([makeItem(overrides as Partial<Item>)]);
    expect(visible).toEqual([]);
    expect(gone).toEqual(["item-1"]);
  });

  it("閲覧者自身の設定で隠れる成人向けは、表示しないが削除もしない", () => {
    const { visible, gone } = resolve([makeItem({ isAdult: true })]);
    expect(visible).toEqual([]);
    expect(gone).toEqual([]);
  });

  it("フォロワー限定はフォロー中だけ表示し、フォロー解除後は削除対象にする", () => {
    const item = makeItem({ visibility: "followers" });
    expect(resolve([item], new Set(["owner"])).visible).toHaveLength(1);
    expect(resolve([item])).toEqual({ visible: [], gone: ["item-1"] });
  });

  it("リンクが変わった作品は以前の価格を比較に使わない", () => {
    expect(resolve([makeItem({ url: "https://old.example/" })]).visible[0].lastPrice).toBe(1000);
    expect(resolve([makeItem({ url: "https://shop.example/other" })]).visible[0].lastPrice).toBeNull();
  });

  it("成人向けは閲覧者の成人申告と表示同意があれば表示する", () => {
    const adultViewer = { uid: "viewer", profile: makeProfile({ isAdult: true, showAdult: true }) };
    expect(resolve([makeItem({ isAdult: true })], new Set(), adultViewer).visible).toEqual([expect.objectContaining({ isAdult: true })]);
  });

  it("削除された作品（退会を含む）は削除対象として返す", () => {
    const { visible, gone } = resolveWishes([wish("deleted")], new Map(), viewer, new Set());
    expect(visible).toEqual([]);
    expect(gone).toEqual(["deleted"]);
  });

  it("検索結果リンクに変わった作品は価格ウォッチを止める", () => {
    expect(resolve([makeItem({ urlIsSearch: true })]).visible[0].watch).toBe(false);
  });

  it("ほしい登録も同じ条件で判定する", () => {
    const ctx = { viewerUid: "viewer", viewerProfile: makeProfile(), following: false };
    expect(canWishItem(makeItem(), ctx)).toBe(true);
    expect(canWishItem(makeItem({ isAdult: true }), ctx)).toBe(false);
    expect(canWishItem(makeItem({ title: "Amazon サインイン" }), ctx)).toBe(false);
    expect(canWishItem(makeItem({ status: "draft", ownerUid: "viewer" }), ctx)).toBe(false);
  });
});
