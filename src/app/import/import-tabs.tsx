"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { importPasteAction, importScreenshotAction, importUrlsAction, type ActionResult } from "@/app/actions";
import type { ImportReport } from "@/lib/ai/agents/importer";

const TABS = [
  { id: "bulk", label: "購入履歴ページから一括" },
  { id: "screenshot", label: "スクショから" },
  { id: "url", label: "商品URLから" },
] as const;

export function ImportResult({ state }: { state: ActionResult<ImportReport> | null }) {
  if (!state) return null;
  if (!state.ok) return <p className="text-sm text-danger">{state.error}</p>;
  const r = state.data;
  return (
    <div className="rounded-xl bg-surface-2 p-3 text-sm">
      {r.detected != null && (
        <p className="mb-1 text-ink-2">
          🤖 取り込みエージェントが購入商品を <b>{r.detected}</b> 件検出
          {r.excluded ? `（おすすめ・広告・補助リンクなど ${r.excluded} 件を除外）` : ""}
          {r.recovered ? `。再確認で ${r.recovered} 件の見落としを回収` : ""}
        </p>
      )}
      <p>
        ✅ <b>{r.created}</b> 件を下書きに追加しました
        {r.skipped > 0 && `（重複 ${r.skipped} 件はスキップ）`}
      </p>
      {r.notes?.map((n) => (
        <p key={n} className="mt-1 text-xs text-warn">
          ℹ️ {n}
        </p>
      ))}
      {r.flagged > 0 && <p className="mt-1 text-warn">🛡️ プライバシーガードが {r.flagged} 件を要確認としてマークしました</p>}
      {r.created > 0 && (
        <Link href="/import/review" className="btn-primary mt-2">
          確認して公開する →
        </Link>
      )}
    </div>
  );
}

export function ImportTabs({ bookmarklet }: { bookmarklet: string }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("bulk");
  const bmRef = useRef<HTMLAnchorElement>(null);
  // React blocks javascript: URLs in JSX, so the bookmarklet href is set directly on the DOM node.
  useEffect(() => {
    bmRef.current?.setAttribute("href", bookmarklet);
  }, [bookmarklet, tab]);
  const [urlState, urlAction, urlPending] = useActionState(importUrlsAction, null);
  const [shotState, shotAction, shotPending] = useActionState(importScreenshotAction, null);
  const [pasteState, pasteAction, pastePending] = useActionState(importPasteAction, null);

  return (
    <div className="card p-5">
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-full bg-surface-2 p-1" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 whitespace-nowrap rounded-full px-3 py-1.5 text-sm ${tab === t.id ? "bg-surface font-bold shadow-sm" : "text-ink-2"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "bulk" && (
        <div className="space-y-6">
          <section>
            <h2 className="font-display font-bold">方法A：ブックマークレット（おすすめ）</h2>
            <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-ink-2">
              <li>
                下のボタンをブックマークバーにドラッグ＆ドロップ
                <div className="my-2">
                  <a
                    ref={bmRef}
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      alert("このボタンをブックマークバーにドラッグしてください");
                    }}
                    className="btn-primary cursor-grab"
                  >
                    📚 推し棚に取り込む
                  </a>
                </div>
              </li>
              <li>FANZA・DLsite・Amazon などの「購入履歴」「ライブラリ」ページを開く（ログインしたまま）</li>
              <li>ブックマークをクリック → ページを自動でスクロール・次のページもたどって、取り込みエージェントが購入した商品だけを読み取ります</li>
            </ol>
            <p className="mt-2 text-xs text-ink-2">
              🔒 パスワードやログイン情報は推し棚に送られません。ページ上の商品リンクとテキストだけを、あなたのブラウザから直接渡します。
            </p>
          </section>
          <section>
            <h2 className="font-display font-bold">方法B：ページのテキストを貼り付け</h2>
            <p className="mt-1 text-sm text-ink-2">購入履歴ページで「すべて選択（⌘A / Ctrl+A）→ コピー」して貼り付けてください。AIが商品名を抽出します。成人向けショップの購入履歴は、方法Aのブックマークレットを使ってください。</p>
            <form action={pasteAction} className="mt-2 space-y-2">
              <textarea name="text" className="input min-h-32" placeholder="ここに貼り付け" maxLength={60000} />
              <button className="btn-primary" disabled={pastePending}>
                {pastePending ? "AIが解析中…" : "解析して取り込む"}
              </button>
              <ImportResult state={pasteState} />
            </form>
          </section>
        </div>
      )}

      {tab === "screenshot" && (
        <form action={shotAction} className="space-y-3">
          <p className="text-sm text-ink-2">購入履歴画面のスクリーンショット（最大5枚）から、Geminiが商品名を読み取ります。氏名・住所などは抽出しません。</p>
          <p className="text-xs text-warn">⚠️ 成人向けショップ（FANZA・DLsite など）の画面には使わず、ブックマークレットで取り込んでください。ブックマークレットなら作品名や画像をAIに送らずに取り込めます。</p>
          <input type="file" name="images" accept="image/png,image/jpeg,image/webp" multiple required className="block text-sm" />
          <button className="btn-primary" disabled={shotPending}>
            {shotPending ? "AIが読み取り中…" : "読み取って取り込む"}
          </button>
          <ImportResult state={shotState} />
        </form>
      )}

      {tab === "url" && (
        <form action={urlAction} className="space-y-3">
          <p className="text-sm text-ink-2">商品ページのURLを貼ってください（改行区切りで最大30件）。どのショップでもOKです。</p>
          <textarea name="urls" className="input min-h-28" placeholder={"https://www.amazon.co.jp/dp/...\nhttps://book.dmm.com/product/..."} required />
          <button className="btn-primary" disabled={urlPending}>
            {urlPending ? "取得中…" : "取り込む"}
          </button>
          <ImportResult state={urlState} />
        </form>
      )}
    </div>
  );
}
