import Link from "next/link";
import { getViewer } from "@/lib/session";
import { unreadCount } from "@/lib/data/social";
import { Avatar } from "./avatar";

const NAV = [
  { href: "/", label: "フィード", icon: "🏠" },
  { href: "/discover", label: "見つける", icon: "🔭" },
  { href: "/import", label: "取り込む", icon: "＋" },
  { href: "/wishlist", label: "ほしい", icon: "♡" },
];

export async function Header() {
  const viewer = await getViewer();
  const profile = viewer?.profile ?? null;
  const unread = profile ? await unreadCount(profile.uid) : 0;

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 font-display text-lg font-bold"
          >
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-sm text-accent-ink">
              棚
            </span>
            推し棚
          </Link>
          {profile ? (
            <>
              <nav className="ml-4 hidden gap-1 sm:flex">
                {NAV.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="rounded-full px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
                  >
                    {n.label}
                  </Link>
                ))}
              </nav>
              <div className="ml-auto flex items-center gap-2">
                <Link
                  href="/notifications"
                  className="relative rounded-full p-2 hover:bg-surface-2"
                  aria-label="通知"
                >
                  <span aria-hidden>🔔</span>
                  {unread > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-ink">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </Link>
                <Link href={`/u/${profile.handle}`} aria-label="自分の棚">
                  <Avatar profile={profile} size={32} />
                </Link>
              </div>
            </>
          ) : (
            <div className="ml-auto flex gap-2">
              <Link href="/login" className="btn-ghost">
                ログイン
              </Link>
              <Link href="/login?mode=signup" className="btn-primary">
                はじめる
              </Link>
            </div>
          )}
        </div>
      </header>
      {/* Outside <header>: its backdrop-filter would become the containing block for position:fixed. */}
      {profile && (
        <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="flex flex-1 flex-col items-center py-2 text-[11px] text-ink-2"
            >
              <span className="text-base" aria-hidden>
                {n.icon}
              </span>
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
