import Link from "next/link";
import { getViewer } from "@/lib/session";
import { unreadCount } from "@/lib/data/social";
import { Avatar } from "./avatar";
import { LogoutButton } from "./logout-button";
import { NavBottomBar, NavTabs } from "./nav-links";

export async function Header() {
  const viewer = await getViewer();
  const profile = viewer?.profile ?? null;
  const unread = profile ? await unreadCount(profile.uid) : 0;

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <Link href="/" className="flex items-center gap-1.5 font-display text-lg font-bold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-sm text-accent-ink">棚</span>
            推し棚
          </Link>
          {profile ? (
            <>
              <NavTabs handle={profile.handle} />
              <div className="ml-auto flex items-center gap-2">
                <Link href="/notifications" className="relative rounded-full p-2 hover:bg-surface-2" aria-label="通知">
                  <span aria-hidden>🔔</span>
                  {unread > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-ink">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </Link>
                <Link href="/settings" aria-label="設定" title="設定">
                  <Avatar profile={profile} size={32} />
                </Link>
                <LogoutButton />
              </div>
            </>
          ) : (
            <>
              <NavTabs handle={null} />
              <div className="ml-auto flex gap-2">
                <Link href="/login" className="btn-ghost">
                  ログイン
                </Link>
                <Link href="/login?mode=signup" className="btn-primary">
                  はじめる
                </Link>
              </div>
            </>
          )}
        </div>
      </header>
      {/* Outside <header>: its backdrop-filter would become the containing block for position:fixed. */}
      <NavBottomBar handle={profile?.handle ?? null} />
    </>
  );
}
