"use client";

import { useState } from "react";
import Link from "next/link";
import { CATEGORY_LABELS } from "@/lib/types";
import { filterShelf, INITIAL_SHELF_FILTERS, type ShelfFilterState, type ShelfFilterItem } from "@/lib/shelf-filters";

export function useShelfFilters<T extends ShelfFilterItem>(items: T[], ownShelf: boolean) {
  const [filters, setFilters] = useState(INITIAL_SHELF_FILTERS);
  return { filters, setFilters, shown: filterShelf(items, filters, ownShelf) };
}

export function ShelfFilters({ items, ownShelf, filters, onChange }: { items: ShelfFilterItem[]; ownShelf: boolean; filters: ShelfFilterState; onChange: (f: ShelfFilterState) => void }) {
  const categories = Object.entries(CATEGORY_LABELS).map(([key, label]) => [`default:${key}`, label]);
  if (ownShelf) categories.push(...[...new Set(items.flatMap((i) => i.shelfCategory ? [i.shelfCategory] : []))].map((c) => [`custom:${c}`, `独自：${c}`]));
  const genres = [...new Set(items.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b, "ja"));
  const shops = [...new Map(items.map((i) => [i.shop, i.shopLabel])).entries()];
  const select = (key: keyof ShelfFilterState, label: string, options: string[][], all = true) => (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      {label}
      <select className="input !w-auto max-w-full" value={filters[key]} onChange={(e) => onChange({ ...filters, [key]: e.target.value })}>
        {all && <option value="">すべて</option>}
        {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
    </label>
  );
  return <div className="flex flex-wrap items-center gap-3">
    <div className="flex flex-wrap items-center gap-2">
      {select("category", "カテゴリーで絞り込み", categories)}
      {ownShelf && <Link href="/settings#shelf-categories" className="btn-ghost !text-xs">独自カテゴリー作成</Link>}
    </div>
    {select("genre", "ジャンルで絞り込み", genres.map((g) => [g, g]))}
    {select("shop", "購入サイトで絞り込み", shops)}
    <button type="button" className="btn-ghost !text-xs" onClick={() => onChange(INITIAL_SHELF_FILTERS)}>条件をリセット</button>
    {select("sort", "並べ替え", [["recent", "公開が新しい順"], ["oldest", "公開が古い順"], ["title", "作品名順"], ["category", "カテゴリー名順"]], false)}
  </div>;
}
