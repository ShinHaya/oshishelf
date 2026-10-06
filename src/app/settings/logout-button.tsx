"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn-ghost"
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
