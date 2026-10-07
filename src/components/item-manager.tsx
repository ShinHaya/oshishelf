"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteItemsAction, publishDraftsAction, updateItemsVisibilityAction, updateItemVisibilityAction } from "@/app/actions";
import { ReviewEditor } from "./review";
import { CATEGORY_LABELS, VISIBILITY_LABELS, type Item, type Visibility } from "@/lib/types";

const GUARD_STYLE = {
  ok: "",
  warn: "border-warn",
  block: "border-danger",
} as const;

export function ItemManager({ items, mode, canAdult }: { items: Item[]; mode: "draft" | "published"; canAdult: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "flagged">("all");
  // Pre-select everything the guard considers safe; flagged items must be opted in explicitly.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(mode === "draft" ? items.filter((i) => (i.guard?.level ?? "ok") === "ok").map((i) => i.id) : []),
  );
  const [vis, setVis] = useState<Record<string, Visibility>>(() =>
    Object.fromEntries(items.map((i) => [i.id, i.guard && i.guard.level !== "ok" && mode === "draft" ? i.guard.suggestedVisibility : i.visibility])),
  );

  const flaggedCount = items.filter((i) => i.guard && i.guard.level !== "ok").length;
  const shown = useMemo(() => (filter === "flagged" ? items.filter((i) => i.guard && i.guard.level !== "ok") : items), [items, filter]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const publish = () =>
    start(async () => {
      const entries = [...selected].map((id) => ({ id, visibility: vis[id] }));
      const r = await publishDraftsAction(entries);
      setMessage(r.ok ? `${r.data} 件を棚に公開しました` : r.error);
      setSelected(new Set());
      router.refresh();
    });

  const [bulkVis, setBulkVis] = useState<Visibility>("public");
  const applyBulkVisibility = () => {
    const ids = [...selected];
    setVis((m) => ({ ...m, ...Object.fromEntries(ids.map((id) => [id, bulkVis])) }));
    if (mode === "draft") return; // drafts: applied when publishing
    start(async () => {
      const r = await updateItemsVisibilityAction(ids, bulkVis);
      setMessage(r.ok ? `${r.data} 件の公開範囲を「${VISIBILITY_LABELS[bulkVis]}」にしました` : r.error);
      router.refresh();
    });
  };

  const remove = () => {
    if (!confirm(`${selected.size} 件を削除します。よろしいですか？`)) return;
    start(async () => {
      const r = await deleteItemsAction([...selected]);
      setMessage(r.ok ? `${r.data} 件を削除しました` : r.error);
      setSelected(new Set());
      router.refresh();
    });
  };

  const changeVisibility = (id: string, v: Visibility) => {
    setVis((m) => ({ ...m, [id]: v }));
    if (mode === "published") start(async () => void (await updateItemVisibilityAction(id, v)));
  };

  if (items.length === 0) return <p className="card p-8 text-center text-sm text-ink-2">{mode === "draft" ? "確認待ちの下書きはありません。" : "棚はまだ空です。"}</p>;

  return (
    <div className="space-y-3">
      <div className="card sticky top-16 z-10 flex flex-wrap items-center gap-2 p-3">
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={selected.size === shown.length && shown.length > 0} onChange={(e) => setSelected(new Set(e.target.checked ? shown.map((i) => i.id) : []))} />
          全選択（{selected.size}/{items.length}）
        </label>
        {flaggedCount > 0 && (
          <button type="button" className="chip !text-warn" onClick={() => setFilter(filter === "all" ? "flagged" : "all")}>
            🛡️ 要確認 {flaggedCount} 件{filter === "flagged" ? "のみ表示中" : ""}
          </button>
        )}
        <div className="flex items-center gap-1.5">
          <select className="input !w-auto !py-1 text-xs" value={bulkVis} onChange={(e) => setBulkVis(e.target.value as Visibility)} aria-label="まとめて変更する公開範囲">
            {(Object.keys(VISIBILITY_LABELS) as Visibility[]).map((v) => (
              <option key={v} value={v}>
                {VISIBILITY_LABELS[v]}
              </option>
            ))}
          </select>
          <button type="button" className="btn-ghost !px-3 !py-1 !text-xs" disabled={pending || selected.size === 0} onClick={applyBulkVisibility}>
            選択した作品をこの公開範囲に
          </button>
        </div>
        <div className="ml-auto flex gap-2">
          <button type="button" className="btn-ghost !text-danger" disabled={pending || selected.size === 0} onClick={remove}>
            削除
          </button>
          {mode === "draft" && (
            <button type="button" className="btn-primary" disabled={pending || selected.size === 0} onClick={publish}>
              {pending ? "処理中…" : `選択した ${selected.size} 件を公開`}
            </button>
          )}
        </div>
      </div>
      {message && <p className="text-sm">{message}</p>}
      <ul className="space-y-2">
        {shown.map((item) => (
          <li key={item.id} className={`card flex gap-3 p-3 ${item.guard ? GUARD_STYLE[item.guard.level] : ""}`}>
            <input type="checkbox" className="mt-1" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={`${item.title} を選択`} />
            <div className="h-20 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-2">
              {item.imageUrl && !(item.isAdult && !canAdult) && <img src={item.imageUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-sm font-medium">{item.title}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <span className="chip">{item.shopLabel}</span>
                <span className="chip">{CATEGORY_LABELS[item.category]}</span>
                {item.isAdult && <span className="chip !bg-danger !text-white">R18</span>}
                {item.urlIsSearch && <span className="chip">リンク：ショップ検索</span>}
                {item.price != null && <span className="chip">¥{item.price.toLocaleString()}</span>}
              </div>
              {item.guard && item.guard.level !== "ok" && (
                <p className={`mt-1.5 text-xs ${item.guard.level === "block" ? "text-danger" : "text-warn"}`}>🛡️ {item.guard.reasons.join(" / ")}</p>
              )}
              {mode === "published" && <ReviewEditor itemId={item.id} review={item.review} />}
            </div>
            <select
              className="input !w-auto self-start !py-1 text-xs"
              value={vis[item.id]}
              onChange={(e) => changeVisibility(item.id, e.target.value as Visibility)}
              aria-label="公開範囲"
            >
              {(Object.keys(VISIBILITY_LABELS) as Visibility[]).map((v) => (
                <option key={v} value={v}>
                  {VISIBILITY_LABELS[v]}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}
