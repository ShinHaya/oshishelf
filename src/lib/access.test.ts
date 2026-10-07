import { describe, expect, it } from "vitest";
import { adultAiAllowed, aiItems, aiSafeItems, canSeeAdult, canSeeItem } from "./access";
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
