"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
      onClick={async () => {
        await fetch("/api/session", { method: "DELETE" });
        router.replace("/");
        router.refresh();
      }}
    >
      ログアウト
    </button>
  );
}
