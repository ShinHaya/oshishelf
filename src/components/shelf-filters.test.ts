import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { makeItem } from "@/lib/test-fixtures";
import { INITIAL_SHELF_FILTERS } from "@/lib/shelf-filters";
import { ShelfFilters } from "./shelf-filters";

const items = [makeItem({ shelfCategory: "個人用分類", tags: ["架空ジャンル"], shop: "fictional", shopLabel: "架空ショップ" })];
function render(ownShelf: boolean) {
  return renderToStaticMarkup(createElement(ShelfFilters, { items, ownShelf, filters: INITIAL_SHELF_FILTERS, onChange: vi.fn() }));
}

describe("棚フィルターの所有者境界", () => {
  it("本人の棚には独自カテゴリーと設定への作成リンクを表示する", () => {
    const html = render(true);
    expect(html).toContain("個人用分類");
    expect(html).toContain('/settings#shelf-categories');
  });
  it("他人の棚には独自カテゴリーと作成リンクを表示しない", () => {
    const html = render(false);
    expect(html).not.toContain("個人用分類");
    expect(html).not.toContain('/settings#shelf-categories');
    expect(html).toContain("架空ジャンル");
    expect(html).toContain("架空ショップ");
    expect(html).toContain("マンガ");
  });
  it("空の棚でも独自カテゴリー作成に移動できる", () => {
    const html = renderToStaticMarkup(createElement(ShelfFilters, { items: [], ownShelf: true, filters: INITIAL_SHELF_FILTERS, onChange: vi.fn() }));
    expect(html).toContain('/settings#shelf-categories');
  });
});
