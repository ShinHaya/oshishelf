"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        setError(false);
        try {
          const res = await fetch("/api/session", { method: "DELETE" });
          if (!res.ok) { setError(true); return; }
          router.replace("/");
          router.refresh();
        } catch {
          setError(true);
        } finally {
          setPending(false);
        }
      }}
    >
      {error ? "ログアウト失敗：再試行" : pending ? "ログアウト中…" : "ログアウト"}
    </button>
  );
}
