import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/session";
import { listShelf } from "@/lib/data/items";
import { getShelfCategories } from "@/lib/data/users";
import { ItemManager } from "@/components/item-manager";
import { canSeeAdult } from "@/lib/access";

export const metadata: Metadata = { title: "棚の編集" };

export default async function ShelfPage() {
  const { uid, profile } = await requireProfile();
  const [items, stored] = await Promise.all([listShelf(uid, 500), getShelfCategories(uid)]);
  // Items categorized before the list was stored still show their category.
  const shelfCategories = [...new Set([...stored, ...items.flatMap((i) => (i.shelfCategory ? [i.shelfCategory] : []))])];
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold">棚の編集</h1>
          <p className="text-sm text-ink-2">独自カテゴリーの作成と振り分け、公開範囲の変更、作品の削除ができます。カテゴリー名は、作品を閲覧できる人の棚にも表示されます。</p>
        </div>
        <Link href={`/u/${profile.handle}`} className="btn-ghost">
          棚を見る
        </Link>
      </div>
      <ItemManager items={items} mode="published" canAdult={canSeeAdult(profile)} shelfCategories={shelfCategories} />
    </div>
  );
}
