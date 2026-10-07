import "server-only";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { db } from "../firebase-admin";
import type { ItemReview, ReviewReaction } from "../types";

const itemRef = (id: string) => db.collection("items").doc(id);
// Top-level (not a subcollection) so a user's reactions can be found by `uid` without a collection-group index.
const reactionsCol = () => db.collection("reviewReactions");
const reactionId = (itemId: string, uid: string) => `${itemId}_${uid}`;

const COUNT_FIELD: Record<ReviewReaction, "review.helpful" | "review.unhelpful"> = {
  helpful: "review.helpful",
  unhelpful: "review.unhelpful",
};

async function deleteRefs(refs: DocumentReference[]) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach((r) => batch.delete(r));
    await batch.commit();
  }
}

/** Create or update the owner's rating/review on one of their published items. Reaction counts are kept. */
export async function setReview(ownerUid: string, itemId: string, input: { rating: number; text: string }) {
  const ref = itemRef(itemId);
  const textCleared = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("ownerUid") !== ownerUid || snap.get("status") !== "published") throw new Error("作品が見つかりません");
    const prev = snap.get("review") as ItemReview | null | undefined;
    // Reactions judged the old text; once the text is cleared there is nothing left to react to.
    const keepCounts = !!prev && !!input.text;
    const review: ItemReview = {
      rating: input.rating,
      text: input.text,
      helpful: keepCounts ? (prev.helpful ?? 0) : 0,
      unhelpful: keepCounts ? (prev.unhelpful ?? 0) : 0,
      updatedAt: Date.now(),
    };
    tx.update(ref, { review });
    return !!prev?.text && !input.text;
  });
  if (textCleared) await deleteReactionsForItems([itemId]);
}

export async function deleteReview(ownerUid: string, itemId: string) {
  const ref = itemRef(itemId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("ownerUid") !== ownerUid) throw new Error("作品が見つかりません");
    tx.update(ref, { review: null });
  });
  await deleteReactionsForItems([itemId]);
}

/**
 * Set (or clear with null) the viewer's reaction to an item's review, keeping the counters on the
 * item in step. Returns the new counts. Visibility checks are the caller's job.
 */
export async function setReaction(uid: string, itemId: string, value: ReviewReaction | null): Promise<{ helpful: number; unhelpful: number; mine: ReviewReaction | null }> {
  const iRef = itemRef(itemId);
  const rRef = reactionsCol().doc(reactionId(itemId, uid));
  return db.runTransaction(async (tx) => {
    const [itemSnap, reactionSnap] = await Promise.all([tx.get(iRef), tx.get(rRef)]);
    const review = itemSnap.get("review") as ItemReview | null | undefined;
    if (!itemSnap.exists || !review?.text) throw new Error("口コミが見つかりません");
    if (itemSnap.get("ownerUid") === uid) throw new Error("自分の口コミにはリアクションできません");
    const prev = reactionSnap.exists ? (reactionSnap.get("value") as ReviewReaction) : null;
    const counts = { helpful: review.helpful ?? 0, unhelpful: review.unhelpful ?? 0 };
    if (prev === value) return { ...counts, mine: prev };

    const patch: Record<string, FieldValue> = {};
    if (prev) {
      patch[COUNT_FIELD[prev]] = FieldValue.increment(-1);
      counts[prev] = Math.max(0, counts[prev] - 1);
    }
    if (value) {
      patch[COUNT_FIELD[value]] = FieldValue.increment(1);
      counts[value] += 1;
      tx.set(rRef, { itemId, uid, itemOwnerUid: itemSnap.get("ownerUid"), value, createdAt: Date.now() });
    } else {
      tx.delete(rRef);
    }
    tx.update(iRef, patch);
    return { ...counts, mine: value };
  });
}

/** The viewer's reactions to the given items' reviews. */
export async function myReactions(uid: string, itemIds: string[]): Promise<Map<string, ReviewReaction>> {
  if (!itemIds.length) return new Map();
  const snaps = await db.getAll(...itemIds.map((id) => reactionsCol().doc(reactionId(id, uid))));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.get("itemId") as string, s.get("value") as ReviewReaction]));
}

export async function deleteReactionsForItems(itemIds: string[]) {
  for (let i = 0; i < itemIds.length; i += 30) {
    const snap = await reactionsCol().where("itemId", "in", itemIds.slice(i, i + 30)).select().get();
    await deleteRefs(snap.docs.map((d) => d.ref));
  }
}

/** Account deletion: undo the user's reactions on others' reviews and drop reactions on their own. */
export async function deleteReactionsOfUser(uid: string) {
  const [given, received] = await Promise.all([reactionsCol().where("uid", "==", uid).get(), reactionsCol().where("itemOwnerUid", "==", uid).select().get()]);
  for (const d of given.docs) {
    const value = d.get("value") as ReviewReaction;
    await itemRef(d.get("itemId"))
      .update({ [COUNT_FIELD[value]]: FieldValue.increment(-1) })
      .catch(() => {});
  }
  await deleteRefs([...given.docs, ...received.docs].map((d) => d.ref));
}
