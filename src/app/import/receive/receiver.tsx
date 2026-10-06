"use client";

import { useEffect, useState, useTransition } from "react";
import { importBulkAction, type ActionResult } from "@/app/actions";
import type { ImportReport } from "@/lib/ai/agents/importer";
import { ImportResult } from "../import-tabs";

interface Payload {
  type: "oshishelf:links";
  page: string;
  links: { href: string; text: string; img?: string | null }[];
  text?: string;
}

export function Receiver() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [result, setResult] = useState<ActionResult<ImportReport> | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // The sender is the shop page; its data is treated as untrusted input and validated server-side.
      if (e.source !== window.opener || e.data?.type !== "oshishelf:links") return;
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

  let host = "";
  try {
    host = new URL(payload.page).hostname;
  } catch {}

  return (
    <div className="card space-y-3 p-6">
      <h1 className="font-display text-xl font-bold">📥 {host} から取り込み</h1>
      <p className="text-sm text-ink-2">
        ページ上のリンク {payload.links.length} 件を受け取りました。商品ページへのリンクだけを抽出し、見つからない場合はページのテキストからAIが商品名を読み取ります。
      </p>
      {!result?.ok && (
        <button
          className="btn-primary w-full"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setResult(await importBulkAction({ page: payload.page, links: payload.links, text: payload.text }));
            })
          }
        >
          {pending ? "取り込み中…（商品ページを確認しています）" : "取り込む"}
        </button>
      )}
      <ImportResult state={result} />
    </div>
  );
}
