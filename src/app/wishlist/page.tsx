import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/session";
import { listVisibleWishes } from "@/lib/data/social";
import { WishButton } from "@/components/wish-button";

export const metadata: Metadata = { title: "ほしいもの" };

export default async function WishlistPage() {
  const { uid, profile } = await requireProfile();
  const wishes = await listVisibleWishes(uid, profile);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold">ほしいもの</h1>
        <p className="text-sm text-ink-2">他の人の棚で ♡ した作品です。ウォッチャーエージェントが値下がりを見張ります。</p>
      </div>
      {wishes.length === 0 && (
        <div className="card p-8 text-center text-sm text-ink-2">
          まだありません。<Link href="/discover" className="text-accent underline">趣味の合う人の棚</Link>を見に行きましょう。
        </div>
      )}
      <ul className="grid gap-2 sm:grid-cols-2">
        {wishes.map((w) => (
          <li key={w.itemId} className="card flex gap-3 p-3">
            <div className="h-24 w-16 shrink-0 overflow-hidden rounded-lg bg-surface-2">
              {w.imageUrl && <img src={w.imageUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <p className="line-clamp-2 text-sm font-medium">{w.title}</p>
              <p className="text-xs text-ink-2">
                {w.shopLabel}
                {w.lastPrice != null && ` ・ ¥${w.lastPrice.toLocaleString()}`}
                {w.watch && " ・ 👀 ウォッチ中"}
              </p>
              <div className="mt-auto flex gap-1.5 pt-2">
                <a href={`/go/${w.itemId}`} target="_blank" rel="noopener noreferrer sponsored" className="btn-primary flex-1 !py-1.5 !text-xs">
                  ショップで見る
                </a>
                <WishButton itemId={w.itemId} initial />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
