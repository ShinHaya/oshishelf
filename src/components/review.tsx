"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteReviewAction, reactToReviewAction, saveReviewAction } from "@/app/actions";
import type { ItemReview, ReviewReaction } from "@/lib/types";

export function Stars({ rating, className = "" }: { rating: number; className?: string }) {
  return (
    <span className={`tracking-tight text-warn ${className}`} role="img" aria-label={`5段階中 ${rating}`}>
      {"★".repeat(rating)}
      <span className="text-ink-2/30">{"★".repeat(5 - rating)}</span>
    </span>
  );
}

/**
 * A review on an item card. `reactAs`: "viewer" can react, "guest" is sent to login,
 * "owner" only sees the counts.
 */
export function ReviewView({
  itemId,
  review,
  mine: initialMine,
  reactAs,
}: {
  itemId: string;
  review: ItemReview;
  mine: ReviewReaction | null;
  reactAs: "viewer" | "guest" | "owner";
}) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState({ helpful: review.helpful, unhelpful: review.unhelpful, mine: initialMine });
  const [pending, start] = useTransition();

  const react = (value: ReviewReaction) =>
    start(async () => {
      const r = await reactToReviewAction(itemId, state.mine === value ? null : value);
      if (r.ok) setState(r.data);
      else alert(r.error);
    });

  const button = (value: ReviewReaction, label: string, icon: string) => {
    const active = state.mine === value;
    const cls = `btn !gap-1 !px-2 !py-0.5 !text-[11px] !font-medium border ${active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink-2"}`;
    const count = value === "helpful" ? state.helpful : state.unhelpful;
    const content = (
      <>
        <span aria-hidden>{icon}</span>
        {label}
        <span className="tabular-nums">{count}</span>
      </>
    );
    if (reactAs === "guest") {
      return (
        <Link href="/login" className={cls} title="ログインするとリアクションできます">
          {content}
        </Link>
      );
    }
    if (reactAs === "owner") {
      return (
        <span className={cls} title="自分の口コミへのリアクション数">
          {content}
        </span>
      );
    }
    return (
      <button type="button" className={cls} disabled={pending} aria-pressed={active} onClick={() => react(value)}>
        {content}
      </button>
    );
  };

  return (
    <div className="space-y-1 rounded-lg bg-surface-2 p-2">
      <Stars rating={review.rating} className="text-sm" />
      {review.text && (
        <>
          <p className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${expanded ? "" : "line-clamp-3"}`}>{review.text}</p>
          {review.text.length > 60 && (
            <button type="button" className="text-[11px] text-accent" onClick={() => setExpanded(!expanded)}>
              {expanded ? "閉じる" : "続きを読む"}
            </button>
          )}
          <div className="flex flex-wrap gap-1 pt-0.5">
            {button("helpful", "役に立った", "👍")}
            {button("unhelpful", "役に立たなかった", "👎")}
          </div>
        </>
      )}
    </div>
  );
}

/** Owner-side editor for an item's rating and review (棚の編集). */
export function ReviewEditor({ itemId, review }: { itemId: string; review: ItemReview | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(review?.rating ?? 0);
  const [text, setText] = useState(review?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const r = await saveReviewAction(itemId, { rating, text });
      if (!r.ok) return setError(r.error);
      setError(null);
      setOpen(false);
      router.refresh();
    });

  const remove = () => {
    if (!confirm("この作品のレビューを削除します。よろしいですか？")) return;
    start(async () => {
      const r = await deleteReviewAction(itemId);
      if (!r.ok) return setError(r.error);
      setRating(0);
      setText("");
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <button type="button" className="mt-1.5 flex items-center gap-1.5 text-xs text-accent" onClick={() => setOpen(true)}>
        {review ? (
          <>
            <Stars rating={review.rating} />
            <span>レビューを編集{review.text ? `（👍${review.helpful} / 👎${review.unhelpful}）` : ""}</span>
          </>
        ) : (
          "☆ 評価・口コミを書く"
        )}
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-line p-2">
      <div className="flex items-center gap-0.5" role="radiogroup" aria-label="評価">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n}`}
            className={`text-xl leading-none ${n <= rating ? "text-warn" : "text-ink-2/30"}`}
            onClick={() => setRating(n)}
          >
            ★
          </button>
        ))}
        <span className="ml-2 text-xs text-ink-2">{rating ? `${rating} / 5` : "評価を選択"}</span>
      </div>
      <textarea
        className="input min-h-20 text-sm"
        maxLength={1000}
        placeholder="口コミ（任意）：よかったところ、おすすめしたい人など"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-ink-2">{text.length}/1000・作品と同じ公開範囲で表示されます</span>
        <div className="ml-auto flex gap-2">
          {review && (
            <button type="button" className="btn-ghost !px-3 !py-1 !text-xs !text-danger" disabled={pending} onClick={remove}>
              削除
            </button>
          )}
          <button type="button" className="btn-ghost !px-3 !py-1 !text-xs" disabled={pending} onClick={() => setOpen(false)}>
            キャンセル
          </button>
          <button type="button" className="btn-primary !px-3 !py-1 !text-xs" disabled={pending || rating === 0} onClick={save}>
            {pending ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
