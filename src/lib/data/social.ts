import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase-admin";
import { resolveWishes } from "../access";
import { getItems } from "./items";
import type { Item, Notification, UserProfile, Wish } from "../types";
import type { VisibleWish } from "../access";

const followId = (follower: string, followee: string) => `${follower}_${followee}`;

export async function isFollowing(follower: string, followee: string): Promise<boolean> {
  if (follower === followee) return false;
  return (await db.collection("follows").doc(followId(follower, followee)).get()).exists;
}

export async function follow(follower: string, followee: string) {
  if (follower === followee) return;
  const ref = db.collection("follows").doc(followId(follower, followee));
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return;
    tx.set(ref, { follower, followee, createdAt: Date.now() });
    tx.update(db.collection("users").doc(follower), { followingCount: FieldValue.increment(1) });
    tx.update(db.collection("users").doc(followee), { followerCount: FieldValue.increment(1) });
  });
}

export async function unfollow(follower: string, followee: string) {
  const ref = db.collection("follows").doc(followId(follower, followee));
  await db.runTransaction(async (tx) => {
    if (!(await tx.get(ref)).exists) return;
    tx.delete(ref);
    tx.update(db.collection("users").doc(follower), { followingCount: FieldValue.increment(-1) });
    tx.update(db.collection("users").doc(followee), { followerCount: FieldValue.increment(-1) });
  });
}

export async function listFollowing(uid: string, limit = 300): Promise<string[]> {
  const snap = await db.collection("follows").where("follower", "==", uid).limit(limit).get();
  return snap.docs.map((d) => d.get("followee"));
}

export async function listFollowers(uid: string, limit = 300): Promise<string[]> {
  const snap = await db.collection("follows").where("followee", "==", uid).limit(limit).get();
  return snap.docs.map((d) => d.get("follower"));
}

// ---- wishes ("ほしい") ----

const wishesCol = (uid: string) => db.collection("users").doc(uid).collection("wishes");

export async function addWish(uid: string, item: Item) {
  const wish: Wish = {
    itemId: item.id,
    ownerUid: item.ownerUid,
    url: item.url,
    title: item.title,
    imageUrl: item.imageUrl,
    shop: item.shop,
    shopLabel: item.shopLabel,
    lastPrice: item.price,
    watch: !item.urlIsSearch,
    createdAt: Date.now(),
    lastCheckedAt: null,
  };
  await wishesCol(uid).doc(item.id).set(wish);
  // Flag on the user doc lets the scheduler find users to patrol without a collection-group index.
  if (wish.watch) await db.collection("users").doc(uid).update({ hasWatch: true });
}

export async function removeWish(uid: string, itemId: string) {
  await wishesCol(uid).doc(itemId).delete();
}

export async function listWishes(uid: string): Promise<Wish[]> {
  const snap = await wishesCol(uid).orderBy("createdAt", "desc").limit(200).get();
  return snap.docs.map((d) => d.data() as Wish);
}

/**
 * The user's wishes that they may still see, refreshed from the live items. Wishes whose item was
 * deleted or withdrawn from them (including the owner leaving) are removed here, so stale copies never linger.
 */
export async function listVisibleWishes(uid: string, profile: UserProfile | null): Promise<VisibleWish[]> {
  const wishes = await listWishes(uid);
  const items = new Map((await getItems(wishes.map((w) => w.itemId))).map((i) => [i.id, i]));
  const followersOnlyOwners = [...new Set([...items.values()].filter((i) => i.visibility === "followers").map((i) => i.ownerUid))];
  const followed = await Promise.all(followersOnlyOwners.map(async (o) => ((await isFollowing(uid, o)) ? o : null)));
  const { visible, gone } = resolveWishes(wishes, items, { uid, profile }, new Set(followed.filter((o): o is string => !!o)));
  if (gone.length) {
    const batch = db.batch();
    gone.forEach((id) => batch.delete(wishesCol(uid).doc(id)));
    await batch.commit().catch((e) => console.error("wishes cleanup", e));
  }
  return visible;
}

/** Remove everyone's wishes for these items (item deletion). Needs the `wishes.itemId` collection-group index. */
export async function deleteWishesForItems(itemIds: string[]) {
  for (let i = 0; i < itemIds.length; i += 30) {
    const snap = await db.collectionGroup("wishes").where("itemId", "in", itemIds.slice(i, i + 30)).select().get();
    await deleteDocs(snap.docs.map((d) => d.ref));
  }
}

/** Remove everyone's wishes for this owner's items (account deletion). Needs the `wishes.ownerUid` collection-group index. */
export async function deleteWishesForOwner(ownerUid: string) {
  const snap = await db.collectionGroup("wishes").where("ownerUid", "==", ownerUid).select().get();
  await deleteDocs(snap.docs.map((d) => d.ref));
}

async function deleteDocs(refs: FirebaseFirestore.DocumentReference[]) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    await batch.commit();
  }
}

export async function wishedIds(uid: string): Promise<Set<string>> {
  const snap = await wishesCol(uid).select().limit(500).get();
  return new Set(snap.docs.map((d) => d.id));
}

export async function updateWish(uid: string, itemId: string, patch: Partial<Wish>) {
  await wishesCol(uid).doc(itemId).update(patch);
}

/** Users that have at least one watched wish (for the watcher agent). */
export async function listWatchingUserIds(limit = 50): Promise<string[]> {
  const snap = await db.collection("users").where("hasWatch", "==", true).select().limit(limit).get();
  return snap.docs.map((d) => d.id);
}

// ---- notifications ----

const notifCol = (uid: string) => db.collection("users").doc(uid).collection("notifications");

export async function notify(uid: string, n: Omit<Notification, "id" | "read" | "createdAt">) {
  await notifCol(uid).add({ ...n, read: false, createdAt: Date.now() });
}

export async function listNotifications(uid: string, limit = 50): Promise<Notification[]> {
  const snap = await notifCol(uid).orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Notification, "id">) }));
}

export async function unreadCount(uid: string): Promise<number> {
  const snap = await notifCol(uid).where("read", "==", false).count().get();
  return snap.data().count;
}

export async function markAllRead(uid: string) {
  const snap = await notifCol(uid).where("read", "==", false).limit(200).get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.update(d.ref, { read: true }));
  await batch.commit();
}

// ---- per-user AI quota (cost & abuse control) ----

const DAILY_LIMITS: Record<string, number> = {
  import: 40,
  screenshot: 15,
  bio: 10,
  compat: 30,
  twin: 60,
  watcher: 5,
};

/** Atomically consume one unit of a daily AI quota. Throws when exhausted. */
export async function consumeQuota(uid: string, kind: keyof typeof DAILY_LIMITS) {
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection("usage").doc(`${uid}_${day}`);
  await db.runTransaction(async (tx) => {
    const used = ((await tx.get(ref)).get(kind) as number | undefined) ?? 0;
    if (used >= DAILY_LIMITS[kind]) throw new Error("本日のAI利用上限に達しました。明日またお試しください。");
    tx.set(ref, { [kind]: used + 1, uid, day }, { merge: true });
  });
}
