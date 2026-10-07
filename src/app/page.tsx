import Link from "next/link";
import { getViewer } from "@/lib/session";
import { listFeed, listRecentPublic } from "@/lib/data/items";
import { listFollowing, wishedIds } from "@/lib/data/social";
import { myReactions } from "@/lib/data/reviews";
import { getUsers } from "@/lib/data/users";
import { canSeeAdult, canSeeItem } from "@/lib/access";
import { recommendUsers } from "@/lib/ai/agents/matcher";
import { ItemCard } from "@/components/item-card";
import { Avatar } from "@/components/avatar";

export default async function Home(props: PageProps<"/">) {
  const viewer = await getViewer();
  if (!viewer?.profile) return <GuestFeed deleted={!!(await props.searchParams).deleted} />;
  const me = viewer.profile;

  const following = await listFollowing(me.uid);
  const [feedRaw, wished, recs] = await Promise.all([
    following.length ? listFeed(following) : Promise.resolve([]),
    wishedIds(me.uid),
    recommendUsers(me.uid, 5).catch(() => []),
  ]);
  const feed = feedRaw.filter((i) => canSeeItem(i, { viewerUid: me.uid, viewerProfile: me, following: true }));
  const [owners, reactions] = await Promise.all([
    getUsers(feed.map((i) => i.ownerUid)),
    myReactions(me.uid, feed.filter((i) => i.review?.text).map((i) => i.id)),
  ]);
  const showAdult = canSeeAdult(me);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
      <section>
        <h1 className="mb-3 font-display text-xl font-bold">フォロー中の人の新しい棚</h1>
        {feed.length === 0 ? (
          <div className="card p-8 text-center text-sm text-ink-2">
            <p>まだフィードが空です。</p>
            <p className="mt-1">「見つける」で好みが近い人をフォローしてみましょう。</p>
            <Link href="/discover" className="btn-primary mt-4">
              趣味の合う人を探す
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {feed
              .filter((i) => showAdult || !i.isAdult)
              .map((item) => (
                <ItemCard key={item.id} item={item} owner={owners.get(item.ownerUid)} wished={wished.has(item.id)} canWish reaction={reactions.get(item.id)} reactAs="viewer" />
              ))}
          </div>
        )}
      </section>
      <aside className="space-y-4">
        <div className="card p-4">
          <h2 className="font-display font-bold">AIのおすすめユーザー</h2>
          <p className="text-xs text-ink-2">棚の嗜好ベクトルが近い人</p>
          <ul className="mt-3 space-y-3">
            {recs.length === 0 && <li className="text-xs text-ink-2">棚を公開するとおすすめが表示されます</li>}
            {recs.map(({ profile, similarity }) => (
              <li key={profile.uid}>
                <Link href={`/u/${profile.handle}`} className="flex items-center gap-2">
                  <Avatar profile={profile} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">{profile.displayName}</span>
                    <span className="block truncate text-xs text-ink-2">{profile.tasteTags.slice(0, 3).join(" / ")}</span>
                  </span>
                  <span className="text-xs font-bold text-accent">{similarity}%</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <Link href="/import" className="card block p-4 hover:bg-surface-2">
          <p className="font-display font-bold">＋ 購入履歴を取り込む</p>
          <p className="text-xs text-ink-2">URL・スクショ・購入履歴ページから一括で</p>
        </Link>
      </aside>
    </div>
  );
}

/** Logged-out visitors (and accounts not yet onboarded) browse everyone's public shelves. */
async function GuestFeed({ deleted }: { deleted: boolean }) {
  const recent = await listRecentPublic(40).catch(() => []);
  const owners = await getUsers(recent.map((i) => i.ownerUid));
  return (
    <div className="space-y-6">
      {deleted && <p className="card p-4 text-center text-sm">退会の手続きが完了しました。これまでご利用いただきありがとうございました。</p>}
      <section className="card p-5 text-center sm:p-8">
        <p className="chip mx-auto">Agentic AI × ファンコミュニティ</p>
        <h1 className="mt-3 font-display text-2xl font-bold leading-tight sm:text-4xl">
          買ったものが、
          <br />
          あなたの<span className="text-accent">自己紹介</span>になる。
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm text-ink-2">
          FANZA・DLsite・Amazon など、どこで買った作品も「棚」に並べて公開。AIエージェントがあなたの嗜好を読み解き、同じ趣味の仲間とつなげます。
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <Link href="/login?mode=signup" className="btn-primary !px-6 !py-3 !text-base">
            棚をつくる
          </Link>
        </div>
      </section>
      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <section>
          <h2 className="mb-3 font-display text-xl font-bold">みんなの新しい棚</h2>
          {recent.length === 0 ? (
            <div className="card p-8 text-center text-sm text-ink-2">まだ公開された作品がありません。</div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {recent.map((item) => (
                <ItemCard key={item.id} item={item} owner={owners.get(item.ownerUid)} />
              ))}
            </div>
          )}
        </section>
        <aside className="space-y-4">
          <div className="card p-4">
            <h2 className="font-display font-bold">ログインするとできること</h2>
            <ul className="mt-3 space-y-3">
              {[
                ["📚", "自分の棚", "買った作品を並べて公開"],
                ["📥", "取り込みエージェント", "購入履歴・スクショ・URLから自動で棚へ"],
                ["🤝", "相性マッチング", "趣味が近い人をAIが推薦"],
                ["♡", "ほしいリスト", "値下がりや新作をAIが見張って通知"],
              ].map(([icon, title, body]) => (
                <li key={title} className="flex gap-2">
                  <span aria-hidden>{icon}</span>
                  <span>
                    <span className="block text-sm font-bold">{title}</span>
                    <span className="block text-xs text-ink-2">{body}</span>
                  </span>
                </li>
              ))}
            </ul>
            <Link href="/login?mode=signup" className="btn-primary mt-4 w-full">
              無料ではじめる
            </Link>
            <Link href="/login" className="btn-ghost mt-2 w-full">
              ログイン
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
