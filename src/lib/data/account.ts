import "server-only";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { adminAuth, db } from "../firebase-admin";
import { deleteReactionsOfUser } from "./reviews";
import { deleteWishesForOwner } from "./social";

async function deleteRefs(refs: DocumentReference[]) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    await batch.commit();
  }
}

/**
 * Permanently delete a user: shelf items, other people's wishes for them, review reactions (given and received), follows (adjusting the other side's counters), wishes,
 * notifications, AI caches/logs, usage counters, handle, profile and the Firebase Auth account.
 */
export async function deleteAccount(uid: string) {
  const userRef = db.collection("users").doc(uid);
  const handle = (await userRef.get()).get("handle") as string | undefined;

  await deleteReactionsOfUser(uid);
  // Other people's wishes copied this user's items; their lists also drop them on read if this fails.
  await deleteWishesForOwner(uid).catch((e) => console.error("deleteWishesForOwner", e));
  const items = await db.collection("items").where("ownerUid", "==", uid).select().get();
  await deleteRefs(items.docs.map((d) => d.ref));

  // Follows: keep the other users' follower/following counts consistent.
  const [following, followers] = await Promise.all([
    db.collection("follows").where("follower", "==", uid).get(),
    db.collection("follows").where("followee", "==", uid).get(),
  ]);
  for (const d of following.docs) {
    await db.collection("users").doc(d.get("followee")).update({ followerCount: FieldValue.increment(-1) }).catch(() => {});
  }
  for (const d of followers.docs) {
    await db.collection("users").doc(d.get("follower")).update({ followingCount: FieldValue.increment(-1) }).catch(() => {});
  }
  await deleteRefs([...following.docs, ...followers.docs].map((d) => d.ref));

  // Compatibility caches where this user is either side (ids are `${viewer}_${target}_${scope}`).
  const compat = await db.collection("compat").select().get();
  await deleteRefs(compat.docs.filter((d) => d.id.split("_").slice(0, 2).includes(uid)).map((d) => d.ref));

  const [runs, usage] = await Promise.all([
    db.collection("agentRuns").where("uid", "==", uid).select().get(),
    db.collection("usage").where("uid", "==", uid).select().get(),
  ]);
  await deleteRefs([...runs.docs, ...usage.docs].map((d) => d.ref));

  if (handle) await db.collection("handles").doc(handle).delete();
  // Removes the profile together with its wishes / notifications subcollections.
  await db.recursiveDelete(userRef);

  await adminAuth.deleteUser(uid).catch((e) => {
    if ((e as { code?: string }).code !== "auth/user-not-found") throw e;
  });
}
