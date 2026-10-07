"use client";

import { useEffect, useState, useTransition } from "react";
import { importBulkAction, type ActionResult } from "@/app/actions";
import type { ImportReport } from "@/lib/ai/agents/importer";
import { BookmarkletLink } from "../bookmarklet-link";
import { ImportResult } from "../import-tabs";

interface Payload {
  type: "oshishelf:cards" | "oshishelf:links";
  version?: number;
  mode?: "remote" | "embedded";
  page: string;
  title?: string;
  cards?: { href: string; text: string; context: string; section: string; imgs: { src: string; alt: string }[]; page: number }[];
  /** Older bookmarklets. */
  links?: { href: string; text: string; img?: string | null }[];
  text?: string;
}

export function Receiver({ bookmarklet, version }: { bookmarklet: string; version: number }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [result, setResult] = useState<ActionResult<ImportReport> | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // The sender is the shop page; its data is treated as untrusted input and validated server-side.
      if (e.source !== window.opener || (e.data?.type !== "oshishelf:cards" && e.data?.type !== "oshishelf:links")) return;
      setPayload(e.data as Payload);
    };
    window.addEventListener("message", onMessage);
    // Only a fixed "ready" string is sent to the opener; no data leaves this page.
    window.opener?.postMessage("oshishelf:ready", "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!payload) {
    return (
      <div className="card p-6 text-center text-sm text-ink-2">
        <p>購入履歴ページからのデータを待っています…</p>
        <p className="mt-2 text-xs">このページは、取り込み用のブックマークレットから開いてください。</p>
      </div>
    );
  }

  if (payload.version !== version) {
    return (
      <div className="card space-y-3 p-6">
        <h1 className="font-display text-xl font-bold">取り込み用ブックマークの更新が必要です</h1>
        <p className="text-sm text-ink-2">購入した商品だけを正確に読み取るため、最初の一度だけ登録済みのブックマークを更新してください。通常は、次回から実行時に最新版を自動で読み込みます。</p>
        <BookmarkletLink href={bookmarklet} update />
        <p className="text-sm text-ink-2">更新後、購入履歴のタブに戻り、更新したブックマークをクリックしてください。</p>
      </div>
    );
  }

  const count = payload.cards?.length ?? payload.links?.length ?? 0;
  const pages = payload.cards ? Math.max(1, ...payload.cards.map((c) => c.page)) : 1;
  let host = "";
  try {
    host = new URL(payload.page).hostname;
  } catch {}

  return (
    <div className="card space-y-3 p-6">
      <h1 className="font-display text-xl font-bold">📥 {host} から取り込み</h1>
      <p className="text-sm text-ink-2">
        {pages > 1 ? `${pages}ページ分の` : "ページ上の"}リンク {count} 件を受け取りました。取り込みエージェントが、購入した商品だけを選び出します（おすすめ・広告・試し読みなどは除外します）。
      </p>
      {payload.mode === "embedded" && (
        <p className="text-xs text-warn">このサイトでは最新版を読み込めなかったため、登録時の読み取り処理を使っています。今後の改善を反映するには、取り込みページでブックマークを更新してください。</p>
      )}
      {!result?.ok && (
        <button
          className="btn-primary w-full"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setResult(await importBulkAction({ page: payload.page, title: payload.title, cards: payload.cards, links: payload.links, text: payload.text }));
            })
          }
        >
          {pending ? "エージェントが購入履歴を読み取り中…（1分ほどかかることがあります）" : "取り込む"}
        </button>
      )}
      <ImportResult state={result} />
    </div>
  );
}
