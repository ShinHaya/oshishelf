import "server-only";
import type { Item } from "../../types";
import { CATEGORY_LABELS } from "../../types";

function countBy<T>(arr: T[], key: (t: T) => string | string[]) {
  const m = new Map<string, number>();
  for (const a of arr) for (const k of [key(a)].flat()) if (k) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Aggregate view of a shelf, given to agents instead of raw rows. */
export function shelfOverview(items: Item[]) {
  return {
    total: items.length,
    byCategory: Object.fromEntries(countBy(items, (i) => CATEGORY_LABELS[i.category])),
    byShop: Object.fromEntries(countBy(items, (i) => i.shopLabel).slice(0, 8)),
    topTags: countBy(items, (i) => i.tags).slice(0, 25).map(([tag, n]) => ({ tag, n })),
  };
}

export function itemBrief(i: Item) {
  return { id: i.id, title: i.title, category: CATEGORY_LABELS[i.category], shop: i.shopLabel, tags: i.tags, price: i.price, ...(i.isAdult ? { adult: true } : {}) };
}

/** Simple keyword search over a shelf (title + tags). */
export function searchShelf(items: Item[], query: string, limit = 12) {
  const terms = query.toLowerCase().split(/[\s、,]+/).filter(Boolean);
  const scored = items
    .map((i) => {
      const hay = `${i.title} ${i.tags.join(" ")} ${CATEGORY_LABELS[i.category]} ${i.shopLabel}`.toLowerCase();
      return { i, score: terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => itemBrief(x.i));
}

/** Text used to embed a user's taste for vector search. */
export function tasteText(items: Item[]): string {
  const ov = shelfOverview(items);
  return [
    `カテゴリ: ${Object.keys(ov.byCategory).join(" ")}`,
    `タグ: ${ov.topTags.map((t) => t.tag).join(" ")}`,
    `作品: ${items.slice(0, 60).map((i) => i.title).join(" / ")}`,
  ].join("\n");
}
