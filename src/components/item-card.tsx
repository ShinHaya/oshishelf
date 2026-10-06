import Link from "next/link";
import type { Item, UserProfile } from "@/lib/types";
import { CATEGORY_LABELS } from "@/lib/types";
import { Avatar } from "./avatar";
import { WishButton } from "./wish-button";

function hueOf(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

/** Book-cover style placeholder for items without an image, tinted per title. */
function GeneratedCover({ title }: { title: string }) {
  const h = hueOf(title);
  return (
    <span
      className="relative flex h-full flex-col justify-between overflow-hidden p-4 text-white"
      style={{ background: `linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 30) % 360} 50% 28%))` }}
    >
      <span className="absolute inset-y-0 left-2 w-px bg-white/25" aria-hidden />
      <span className="mt-6 line-clamp-5 font-display text-lg font-bold leading-snug drop-shadow-sm">{title}</span>
      <span className="text-[10px] tracking-widest text-white/70">OSHISHELF</span>
    </span>
  );
}

export function ItemCard({
  item,
  owner,
  wished,
  canWish,
  hideAdult,
}: {
  item: Item;
  owner?: UserProfile;
  wished?: boolean;
  canWish?: boolean;
  /** Viewer has not opted in to R18: render a locked placeholder instead. */
  hideAdult?: boolean;
}) {
  if (item.isAdult && hideAdult) {
    return (
      <div className="card flex aspect-[3/5] flex-col items-center justify-center gap-1 p-3 text-center text-xs text-ink-2">
        <span className="rounded bg-surface-2 px-2 py-0.5 font-bold">R18</span>
        <span>18歳以上の方は設定で表示をONにできます</span>
      </div>
    );
  }
  return (
    <article className="card group flex flex-col overflow-hidden">
      <a href={`/go/${item.id}`} target="_blank" rel="noopener noreferrer sponsored" className="relative block aspect-[3/4] bg-surface-2">
        {item.imageUrl ? (
          <img src={item.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
        ) : (
          <GeneratedCover title={item.title} />
        )}
        <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white">{item.shopLabel}</span>
        {item.isAdult && <span className="absolute right-2 top-2 rounded bg-danger px-1.5 py-0.5 text-[10px] font-bold text-white">R18</span>}
      </a>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        <a href={`/go/${item.id}`} target="_blank" rel="noopener noreferrer sponsored" className="line-clamp-2 text-sm font-medium leading-snug hover:text-accent">
          {item.title}
        </a>
        <div className="flex flex-wrap gap-1">
          <span className="chip">{CATEGORY_LABELS[item.category]}</span>
          {item.tags.slice(0, 2).map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
        <div className="mt-auto flex items-center gap-2 pt-1">
          {owner && (
            <Link href={`/u/${owner.handle}`} className="flex min-w-0 items-center gap-1.5 text-xs text-ink-2 hover:text-ink">
              <Avatar profile={owner} size={20} />
              <span className="truncate">{owner.displayName}</span>
            </Link>
          )}
          {item.price != null && <span className="ml-auto text-xs font-bold">¥{item.price.toLocaleString()}</span>}
        </div>
        <div className="flex gap-1.5">
          <a href={`/go/${item.id}`} target="_blank" rel="noopener noreferrer sponsored" className="btn-primary flex-1 !px-2 !py-1.5 !text-xs">
            {item.urlIsSearch ? "ショップで探す" : "ショップで見る"}
          </a>
          {canWish && <WishButton itemId={item.id} initial={!!wished} />}
        </div>
      </div>
    </article>
  );
}
