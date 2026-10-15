"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createShelfCategoryAction, deleteShelfCategoryAction } from "@/app/actions";
import type { Item } from "@/lib/types";

/** The one place where shelf categories are created and deleted; items are assigned from the selection bar. */
export function ShelfCategoryManager({ categories, items }: { categories: string[]; items: Pick<Item, "shelfCategory">[] }) {
  const router = useRouter();
  const [message, onMessage] = useState("");
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const create = () =>
    start(async () => {
      const r = await createShelfCategoryAction(name);
      onMessage(r.ok ? `カテゴリー「${r.data}」を作成しました。作品を選んで追加できます` : r.error);
      if (!r.ok) return;
      setName("");
      router.refresh();
    });
  const remove = (c: string) => {
    if (!confirm(`カテゴリー「${c}」を削除します。作品は棚に残り、このカテゴリーから外れます。よろしいですか？`)) return;
    start(async () => {
      const r = await deleteShelfCategoryAction(c);
      onMessage(r.ok ? `カテゴリー「${c}」を削除しました` : r.error);
      router.refresh();
    });
  };
  return (
    <section id="shelf-categories" className="card space-y-2 p-3">
      <h2 className="text-sm font-bold">独自カテゴリー</h2>
      {message && <p role="status" className="text-sm">{message}</p>}
      {categories.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <li key={c} className="chip flex items-center gap-1">
              {c} <span className="text-ink-2">{items.filter((i) => i.shelfCategory === c).length}</span>
              <button type="button" className="ml-0.5 text-ink-2 hover:text-danger" disabled={pending} onClick={() => remove(c)} aria-label={`カテゴリー「${c}」を削除`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-2">カテゴリーを作成すると、チェックを入れた作品をまとめて追加できます。</p>
      )}
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <input className="input !w-auto min-w-0 flex-1 !py-1 text-xs" value={name} onChange={(e) => setName(e.target.value)}
          maxLength={40} placeholder="例：お気に入り・積読" aria-label="新しいカテゴリー名" disabled={pending} />
        <button type="submit" className="btn-ghost !px-3 !py-1 !text-xs" disabled={pending || !name.trim()}>
          {pending ? "作成中…" : "作成"}
        </button>
      </form>
    </section>
  );
}
