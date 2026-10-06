import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/session";
import { listDrafts } from "@/lib/data/items";
import { ImportTabs } from "./import-tabs";
import { bookmarkletHref } from "@/lib/bookmarklet";

export const metadata: Metadata = { title: "購入履歴を取り込む" };

export default async function ImportPage() {
  const { uid } = await requireProfile();
  const drafts = await listDrafts(uid);
  const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl font-bold">購入履歴を取り込む</h1>
        <p className="text-sm text-ink-2">取り込んだ商品はいったん「下書き」になります。AIのプライバシーチェック後、あなたが確認してから公開されます。</p>
      </div>
      {drafts.length > 0 && (
        <Link href="/import/review" className="card flex items-center justify-between border-accent bg-accent-soft p-4">
          <span className="text-sm">
            確認待ちの下書きが <b>{drafts.length}</b> 件あります
          </span>
          <span className="btn-primary">確認して公開 →</span>
        </Link>
      )}
      <ImportTabs bookmarklet={bookmarkletHref(origin)} />
    </div>
  );
}
