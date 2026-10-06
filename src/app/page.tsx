import Link from "next/link";
import { getViewer } from "@/lib/session";
import { listFeed, listRecentPublic } from "@/lib/data/items";
import { listFollowing, wishedIds } from "@/lib/data/social";
import { getUsers } from "@/lib/data/users";
import { canSeeAdult, canSeeItem } from "@/lib/access";
import { recommendUsers } from "@/lib/ai/agents/matcher";
import { ItemCard } from "@/components/item-card";
import { Avatar } from "@/components/avatar";

export default async function Home() {
  const viewer = await getViewer();
  if (!viewer?.profile) return <Landing />;
  const me = viewer.profile;

  const following = await listFollowing(me.uid);
  const [feedRaw, wished, recs] = await Promise.all([
    following.length ? listFeed(following) : Promise.resolve([]),
    wishedIds(me.uid),
    recommendUsers(me.uid, 5).catch(() => []),
  ]);
  const feed = feedRaw.filter((i) => canSeeItem(i, { viewerUid: me.uid, viewerProfile: me, following: true }));
  const owners = await getUsers(feed.map((i) => i.ownerUid));
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
                <ItemCard key={item.id} item={item} owner={owners.get(item.ownerUid)} wished={wished.has(item.id)} canWish />
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

async function Landing() {
  const recent = await listRecentPublic(12).catch(() => []);
  const owners = await getUsers(recent.map((i) => i.ownerUid));
  return (
    <div className="space-y-10">
      <section className="py-10 text-center">
        <p className="chip mx-auto">Agentic AI × ファンコミュニティ</p>
        <h1 className="mt-4 font-display text-4xl font-bold leading-tight sm:text-5xl">
          買ったものが、
          <br />
          あなたの<span className="text-accent">自己紹介</span>になる。
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-ink-2">
          FANZA・DLsite・Amazon など、どこで買った作品も「棚」に並べて公開。AIエージェントがあなたの嗜好を読み解き、同じ趣味の仲間とつなげます。
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/login?mode=signup" className="btn-primary !px-6 !py-3 !text-base">
            棚をつくる
          </Link>
          <Link href="/login" className="btn-ghost !px-6 !py-3 !text-base">
            デモを見る
          </Link>
        </div>
      </section>
      <section className="grid gap-3 sm:grid-cols-3">
        {[
          ["📥", "取り込みエージェント", "購入履歴ページ・スクショ・URLから商品を自動で抽出して棚へ"],
          ["🛡️", "プライバシーガード", "公開前に、見られたくなさそうな商品をAIが見つけて確認"],
          ["🤝", "相性マッチング", "嗜好ベクトルで趣味が近い人を推薦し、合う理由を説明"],
          ["💬", "AI分身チャット", "フォローした人の棚から生まれた分身に、おすすめを聞ける"],
          ["👀", "ウォッチャー", "ほしい商品の値下がりや好きな作家の新作を自律巡回して通知"],
          ["✍️", "自己紹介生成", "棚から嗜好を推論して、あなたらしい自己紹介文を作成"],
        ].map(([icon, title, body]) => (
          <div key={title} className="card p-4">
            <p className="text-2xl">{icon}</p>
            <p className="mt-1 font-display font-bold">{title}</p>
            <p className="text-sm text-ink-2">{body}</p>
          </div>
        ))}
      </section>
      {recent.length > 0 && (
        <section>
          <h2 className="mb-3 font-display text-lg font-bold">みんなの新しい棚</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {recent.map((item) => (
              <ItemCard key={item.id} item={item} owner={owners.get(item.ownerUid)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
