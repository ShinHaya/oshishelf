"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  icon: string;
}

function items(handle: string): NavItem[] {
  return [
    { href: `/u/${handle}`, label: "自分の棚", icon: "📚" },
    { href: "/", label: "フィード", icon: "🏠" },
    { href: "/discover", label: "見つける", icon: "🔭" },
    { href: "/import", label: "取り込む", icon: "＋" },
    { href: "/wishlist", label: "ほしい", icon: "♡" },
  ];
}

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** Desktop tabs in the header. */
export function NavTabs({ handle }: { handle: string }) {
  const pathname = usePathname();
  return (
    <nav className="ml-4 hidden gap-1 sm:flex">
      {items(handle).map((n) => {
        const active = isActive(pathname, n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 text-sm ${active ? "bg-accent-soft font-bold text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Fixed bottom bar on phones. */
export function NavBottomBar({ handle }: { handle: string }) {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden">
      {items(handle).map((n) => {
        const active = isActive(pathname, n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`flex flex-1 flex-col items-center py-2 text-[11px] ${active ? "font-bold text-accent" : "text-ink-2"}`}
          >
            <span className="text-base" aria-hidden>
              {n.icon}
            </span>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
