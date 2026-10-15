import Link from "next/link";
import { listShelf } from "@/lib/data/items";
import { getShelfCategories } from "@/lib/data/users";
import { ShelfCategoryManager } from "@/components/shelf-category-manager";
import type { Metadata } from "next";
import { requireProfile } from "@/lib/session";
import { SettingsForm } from "./settings-form";
import { BioGenerator } from "./bio-generator";
import { DeleteAccount } from "./delete-account";

export const metadata: Metadata = { title: "設定" };

export default async function SettingsPage() {
  const { uid, profile } = await requireProfile();
  const [items, stored] = await Promise.all([listShelf(uid, 500), getShelfCategories(uid)]);
  const categories = [...new Set([...stored, ...items.flatMap((i) => i.shelfCategory ? [i.shelfCategory] : [])])];
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="font-display text-2xl font-bold">設定</h1>
      <div className="flex flex-wrap gap-2">
        <Link href={`/u/${profile.handle}`} className="btn-ghost">自分の棚を見る</Link>
        <Link href="/shelf" className="btn-ghost">棚の編集に戻る</Link>
      </div>
      <ShelfCategoryManager categories={categories} items={items.map((i) => ({ shelfCategory: i.shelfCategory }))} />
      <BioGenerator current={profile.aiBio} draft={profile.aiBioDraft} aiUseAdult={profile.isAdult && profile.aiUseAdult} />
      <SettingsForm profile={profile} />
      <DeleteAccount handle={profile.handle} />
    </div>
  );
}
