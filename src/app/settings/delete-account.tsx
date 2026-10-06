"use client";

import { useState, useTransition } from "react";
import { deleteAccountAction } from "@/app/actions";

export function DeleteAccount({ handle }: { handle: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <section className="card space-y-3 border-danger/40 p-5">
      <h2 className="font-display font-bold text-danger">退会する</h2>
      <p className="text-xs text-ink-2">
        アカウントと、棚・フォロー・ほしいもの・通知・AIの分析結果など、あなたのデータをすべて削除します。この操作は取り消せません。
      </p>
      {!open ? (
        <button type="button" className="btn-ghost !text-danger" onClick={() => setOpen(true)}>
          退会の手続きへ
        </button>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              setError(null);
              const r = await deleteAccountAction(confirm);
              // On success the action redirects; we only get here on failure.
              if (!r.ok) setError(r.error);
            });
          }}
        >
          <label className="block text-sm">
            確認のため、あなたのハンドル <b>@{handle}</b> を入力してください
            <input className="input mt-1" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={handle} autoComplete="off" />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)} disabled={pending}>
              やめる
            </button>
            <button className="btn bg-danger text-white" disabled={pending || confirm.replace(/^@/, "").toLowerCase() !== handle}>
              {pending ? "削除中…" : "すべてのデータを削除して退会する"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
