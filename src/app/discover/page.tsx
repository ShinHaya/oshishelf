import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/session";
import { recommendUsers } from "@/lib/ai/agents/matcher";
import { listFollowing } from "@/lib/data/social";
import { listRecentUsers } from "@/lib/data/users";
import { Avatar } from "@/components/avatar";
import { FollowButton } from "@/components/follow-button";
import type { UserProfile } from "@/lib/types";

export const metadata: Metadata = { title: "見つける" };

function UserRow({ profile, similarity, following }: { profile: UserProfile; similarity?: number; following: boolean }) {
  return (
    <li className="card flex items-center gap-3 p-4">
      <Link href={`/u/${profile.handle}`}>
        <Avatar profile={profile} size={48} />
      </Link>
      <Link href={`/u/${profile.handle}`} className="min-w-0 flex-1">
        <p className="font-bold">
          {profile.displayName} <span className="text-xs font-normal text-ink-2">@{profile.handle}</span>
        </p>
        <p className="line-clamp-1 text-sm text-ink-2">{profile.aiBio?.catchphrase ?? profile.bio}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {profile.tasteTags.slice(0, 4).map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      </Link>
      {similarity != null && (
        <div className="text-center">
          <p className="font-display text-xl font-bold text-accent">{similarity}%</p>
          <p className="text-[10px] text-ink-2">嗜好の近さ</p>
        </div>
      )}
      <FollowButton targetUid={profile.uid} initial={following} />
    </li>
  );
}

export default async function DiscoverPage() {
  const { uid } = await requireProfile();
  const [recs, recent, following] = await Promise.all([recommendUsers(uid, 10).catch(() => []), listRecentUsers(20), listFollowing(uid)]);
  const followingSet = new Set(following);
  const recIds = new Set(recs.map((r) => r.profile.uid));
  const others = recent.filter((u) => u.uid !== uid && !recIds.has(u.uid) && u.itemCount > 0);

  return (
    <div className="space-y-6">
      <section>
        <h1 className="font-display text-2xl font-bold">趣味が合いそうな人</h1>
        <p className="text-sm text-ink-2">棚の作品・タグから作った嗜好ベクトルをAIで比較し、近い人を表示しています（Firestore ベクトル検索）。</p>
        <ul className="mt-3 space-y-2">
          {recs.length === 0 && <li className="card p-6 text-center text-sm text-ink-2">作品を公開すると、あなたに近い人が表示されます。</li>}
          {recs.map((r) => (
            <UserRow key={r.profile.uid} profile={r.profile} similarity={r.similarity} following={false} />
          ))}
        </ul>
      </section>
      {others.length > 0 && (
        <section>
          <h2 className="font-display text-lg font-bold">新しく棚をつくった人</h2>
          <ul className="mt-3 space-y-2">
            {others.map((p) => (
              <UserRow key={p.uid} profile={p} following={followingSet.has(p.uid)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
