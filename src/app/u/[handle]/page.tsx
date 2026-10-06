import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/session";
import { getUserByHandle } from "@/lib/data/users";
import { listShelf } from "@/lib/data/items";
import { isFollowing, wishedIds } from "@/lib/data/social";
import { canSeeAdult, canSeeItem } from "@/lib/access";
import { getCachedCompatibility } from "@/lib/ai/agents/matcher";
import { CATEGORY_LABELS, type Category, type Item } from "@/lib/types";
import { Avatar } from "@/components/avatar";
import { FollowButton } from "@/components/follow-button";
import { ItemCard } from "@/components/item-card";
import { CompatPanel } from "./compat-panel";
import { TwinChat } from "./twin-chat";

export async function generateMetadata(props: PageProps<"/u/[handle]">): Promise<Metadata> {
  const { handle } = await props.params;
  const user = await getUserByHandle(handle);
  return user ? { title: `${user.displayName} (@${user.handle}) の棚`, description: user.aiBio?.text ?? user.bio } : {};
}

export default async function ProfilePage(props: PageProps<"/u/[handle]">) {
  const { handle } = await props.params;
  const [owner, viewer] = await Promise.all([getUserByHandle(handle), getViewer()]);
  if (!owner) notFound();
  const me = viewer?.profile ?? null;
  const isMe = me?.uid === owner.uid;

  const [shelf, following, wished, compat] = await Promise.all([
    listShelf(owner.uid),
    me && !isMe ? isFollowing(me.uid, owner.uid) : Promise.resolve(false),
    me ? wishedIds(me.uid) : Promise.resolve(new Set<string>()),
    me && !isMe ? getCachedCompatibility(me.uid, owner.uid) : Promise.resolve(null),
  ]);
  const visible = shelf.filter((i) => canSeeItem(i, { viewerUid: me?.uid ?? null, viewerProfile: me, following }));
  // The viewer decides: R18 items show only for viewers who declared 18+ and turned display on.
  const showAdult = canSeeAdult(me);
  const adultHidden = visible.filter((i) => i.isAdult && !showAdult).length;
  const items = visible.filter((i) => showAdult || !i.isAdult);

  const groups = new Map<Category, Item[]>();
  for (const it of items) groups.set(it.category, [...(groups.get(it.category) ?? []), it]);

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar profile={owner} size={72} />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl font-bold">{owner.displayName}</h1>
            <p className="text-sm text-ink-2">@{owner.handle}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 whitespace-nowrap text-sm">
              <span>
                <b>{owner.itemCount}</b> 作品
              </span>
              <span>
                <b>{owner.followerCount}</b> フォロワー
              </span>
              <span>
                <b>{owner.followingCount}</b> フォロー中
              </span>
            </div>
          </div>
          {/* Full-width row under the name on phones, top-right on wider screens. */}
          <div className="flex w-full gap-2 sm:w-auto [&>*]:flex-1 sm:[&>*]:flex-none">
            {isMe ? (
              <>
                <Link href="/shelf" className="btn-ghost">
                  棚を編集
                </Link>
                <Link href="/settings" className="btn-ghost">
                  設定
                </Link>
              </>
            ) : me ? (
              <FollowButton targetUid={owner.uid} initial={following} />
            ) : (
              <Link href="/login" className="btn-primary">
                ログインしてフォロー
              </Link>
            )}
          </div>
        </div>
        {owner.aiBio && (
          <div className="mt-4 rounded-xl bg-accent-soft p-4">
            <p className="text-xs font-bold text-accent">✨ AIが棚から読み解いた自己紹介</p>
            <p className="mt-1 font-display text-lg font-bold">{owner.aiBio.catchphrase}</p>
            <p className="mt-1 text-sm leading-relaxed">{owner.aiBio.text}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {owner.aiBio.traits.map((t) => (
                <span key={t} className="chip !bg-surface">
                  #{t}
                </span>
              ))}
            </div>
          </div>
        )}
        {owner.bio && <p className="mt-3 whitespace-pre-wrap text-sm">{owner.bio}</p>}
        {isMe && !owner.aiBio && (
          <Link href="/settings#ai-bio" className="mt-4 block rounded-xl border border-dashed border-accent p-3 text-center text-sm text-accent">
            ✨ AIに棚から自己紹介文を作ってもらう
          </Link>
        )}
      </section>

      {me && !isMe && (
        <div className="grid gap-4 md:grid-cols-2">
          <CompatPanel targetUid={owner.uid} targetName={owner.displayName} initial={compat} />
          {owner.twinEnabled && <TwinChat handle={owner.handle} name={owner.displayName} />}
        </div>
      )}

      <section className="space-y-6">
        {items.length === 0 && <p className="card p-8 text-center text-sm text-ink-2">公開されている作品はまだありません。</p>}
        {[...groups.entries()].map(([cat, list]) => (
          <div key={cat}>
            <h2 className="mb-2 font-display font-bold">
              {CATEGORY_LABELS[cat]} <span className="text-sm font-normal text-ink-2">{list.length}</span>
            </h2>
            <div className="shelf-row grid grid-cols-2 gap-3 pb-4 sm:grid-cols-4 lg:grid-cols-5">
              {list.map((item) => (
                <ItemCard key={item.id} item={item} wished={wished.has(item.id)} canWish={!!me && !isMe} />
              ))}
            </div>
          </div>
        ))}
        {adultHidden > 0 && (
          <p className="text-center text-xs text-ink-2">
            成人向け作品 {adultHidden} 件は非表示です（18歳以上の方は設定で表示をONにできます）
          </p>
        )}
      </section>
    </div>
  );
}
