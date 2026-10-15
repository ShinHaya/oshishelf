import { CATEGORY_LABELS, type Item } from "./types";

export type ShelfFilterItem = Pick<Item, "id" | "category" | "shelfCategory" | "tags" | "shop" | "shopLabel" | "publishedAt" | "title">;

export interface ShelfFilterState {
  category: string;
  genre: string;
  shop: string;
  sort: string;
}
export const INITIAL_SHELF_FILTERS: ShelfFilterState = { category: "", genre: "", shop: "", sort: "recent" };

/** Receives only items already authorized for the viewer by the server. */
export function filterShelf<T extends Pick<Item, "category" | "shelfCategory" | "tags" | "shop" | "publishedAt" | "title">>(items: T[], filters: ShelfFilterState, ownShelf: boolean): T[] {
  return items.filter((i) =>
    (!filters.category || `default:${i.category}` === filters.category || (ownShelf && !!i.shelfCategory && `custom:${i.shelfCategory}` === filters.category)) &&
    (!filters.genre || i.tags.includes(filters.genre)) && (!filters.shop || i.shop === filters.shop)
  ).sort((a, b) => {
    const recent = (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
    if (filters.sort === "oldest") return -recent;
    if (filters.sort === "title") return a.title.localeCompare(b.title, "ja") || recent;
    if (filters.sort === "category") return CATEGORY_LABELS[a.category].localeCompare(CATEGORY_LABELS[b.category], "ja") || recent;
    return recent;
  });
}
