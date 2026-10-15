"use client";

import type { ReactNode } from "react";
import type { ShelfFilterItem } from "@/lib/shelf-filters";
import { ShelfFilters, useShelfFilters } from "./shelf-filters";

export function ShelfBrowser({ entries, ownShelf }: { entries: { item: ShelfFilterItem; content: ReactNode }[]; ownShelf: boolean }) {
  const items = entries.map((entry) => entry.item);
  const { filters, setFilters, shown } = useShelfFilters(items, ownShelf);
  const content = new Map(entries.map((entry) => [entry.item.id, entry.content]));
  return <div className="space-y-6">
    <ShelfFilters items={items} ownShelf={ownShelf} filters={filters} onChange={setFilters} />
    {shown.length === 0 && <p className="card p-8 text-center text-sm text-ink-2">条件に合う作品はありません。</p>}
    <div className="shelf-row grid grid-cols-2 gap-3 pb-4 sm:grid-cols-4 lg:grid-cols-5">
      {shown.map((item) => <div key={item.id}>{content.get(item.id)}</div>)}
    </div>
  </div>;
}
