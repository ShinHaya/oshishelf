import type { Metadata } from "next";
import { requireProfile } from "@/lib/session";
import { listDrafts } from "@/lib/data/items";
import { ItemManager } from "@/components/item-manager";
import { canSeeAdult } from "@/lib/access";

export const metadata: Metadata = { title: "下書きの確認" };

export default async function ReviewPage() {
  const { uid, profile } = await requireProfile();
  const drafts = await listDrafts(uid);
  // Flagged items first so the user sees them before publishing.
  const rank = { block: 0, warn: 1, ok: 2 } as const;
  drafts.sort((a, b) => rank[a.guard?.level ?? "ok"] - rank[b.guard?.level ?? "ok"]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold">確認して公開</h1>
        <p className="text-sm text-ink-2">
          🛡️ プライバシーガードが「見られたくないかも」と判断した商品は、選択が外れた状態で表示されています。公開範囲を選んで公開するか、削除してください。
        </p>
      </div>
      <ItemManager items={drafts} mode="draft" canAdult={canSeeAdult(profile)} />
    </div>
  );
}
