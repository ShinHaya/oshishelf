"use client";

import { useState, type ReactNode } from "react";

export function ShelfBrowser({ groups }: { groups: { key: string; label: string; count: number; content: ReactNode }[] }) {
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("recent");
  const shown = groups.filter((group) => !category || group.key === category);
  if (sort === "category") shown.sort((a, b) => a.label.localeCompare(b.label, "ja") || a.key.localeCompare(b.key));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <label className="flex items-center gap-2 text-sm">
          カテゴリーで絞り込み
          <select className="input !w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">すべて</option>
            {groups.map((group) => <option key={group.key} value={group.key}>{group.label}（{group.count}）</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          並べ替え
          <select className="input !w-auto" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="recent">新しく公開したカテゴリー順</option>
            <option value="category">カテゴリー名順</option>
          </select>
        </label>
      </div>
      {shown.map((group) => <div key={group.key}>{group.content}</div>)}
    </div>
  );
}
