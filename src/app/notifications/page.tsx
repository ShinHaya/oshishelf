import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/session";
import { listNotifications, markAllRead } from "@/lib/data/social";
import { db } from "@/lib/firebase-admin";
import { WatcherButton } from "./watcher-button";

export const metadata: Metadata = { title: "通知" };

const ICON = { price_drop: "💸", new_release: "🆕", follow: "👋", agent: "🤖" } as const;

export default async function NotificationsPage() {
  const { uid } = await requireProfile();
  const [list, lastRun] = await Promise.all([
    listNotifications(uid),
    db.collection("agentRuns").where("uid", "==", uid).where("agent", "==", "watcher").orderBy("startedAt", "desc").limit(1).get(),
  ]);
  // Viewing the page marks everything read (after we've captured the unread state above).
  if (list.some((n) => !n.read)) await markAllRead(uid);
  const run = lastRun.docs[0]?.data();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="font-display text-2xl font-bold">通知</h1>
      <section className="card p-4">
        <p className="font-display font-bold">👀 ウォッチャーエージェント</p>
        <p className="text-sm text-ink-2">毎朝、あなたの「ほしい」商品の値下がりと、好きなジャンル・作家の新作を自動で巡回します。</p>
        {run && (
          <p className="mt-2 rounded-lg bg-surface-2 p-2 text-xs">
            前回の巡回（{new Date(run.startedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}）：{run.ok ? run.summary : "失敗しました"}
          </p>
        )}
        <WatcherButton />
      </section>
      <ul className="space-y-2">
        {list.length === 0 && <li className="card p-6 text-center text-sm text-ink-2">通知はまだありません</li>}
        {list.map((n) => {
          const body = (
            <>
              <span className="text-xl">{ICON[n.kind]}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{n.title}</span>
                <span className="block text-sm text-ink-2">{n.body}</span>
                <span className="block text-xs text-ink-2">{new Date(n.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</span>
              </span>
              {!n.read && <span className="h-2 w-2 rounded-full bg-accent" aria-label="未読" />}
            </>
          );
          return (
            <li key={n.id}>
              {n.url?.startsWith("/") ? (
                <Link href={n.url} className="card flex items-start gap-3 p-3 hover:bg-surface-2">
                  {body}
                </Link>
              ) : n.url ? (
                <a href={n.url} target="_blank" rel="noopener noreferrer sponsored" className="card flex items-start gap-3 p-3 hover:bg-surface-2">
                  {body}
                </a>
              ) : (
                <div className="card flex items-start gap-3 p-3">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
