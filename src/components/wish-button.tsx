"use client";

import { useState, useTransition } from "react";
import { toggleWishAction } from "@/app/actions";

export function WishButton({ itemId, initial }: { itemId: string; initial: boolean }) {
  const [wished, setWished] = useState(initial);
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={wished}
      title={wished ? "ほしいリストから外す" : "ほしいリストに追加（値下がりをAIが見張ります）"}
      onClick={() =>
        start(async () => {
          const r = await toggleWishAction(itemId, wished);
          if (r.ok) setWished(r.data);
          else alert(r.error);
        })
      }
      className={`btn !px-2.5 !py-1.5 !text-xs border ${wished ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink-2"}`}
    >
      {wished ? "♥" : "♡"}
    </button>
  );
}
