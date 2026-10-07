import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase-admin";
import { deleteReactionsForItems } from "./reviews";
import { lacksProductInfo } from "../shops";
import type { Category, GuardResult, ImportSource, Item, ItemStatus, Visibility } from "../types";

export const itemsCol = () => db.collection("items");

export function toItem(id: string, d: FirebaseFirestore.DocumentData): Item {
  return {
    id,
    ownerUid: d.ownerUid,
    url: d.url,
    urlIsSearch: !!d.urlIsSearch,
    shop: d.shop,
    shopLabel: d.shopLabel,
    title: d.title,
    imageUrl: d.imageUrl ?? null,
    price: d.price ?? null,
    category: d.category ?? "other",
    shelfCategory: d.shelfCategory ?? null,
    tags: d.tags ?? [],
    isAdult: !!d.isAdult,
    visibility: d.visibility ?? "public",
    status: d.status ?? "draft",
    guard: d.guard ?? null,
    note: d.note ?? "",
    review: d.review
      ? { rating: d.review.rating, text: d.review.text ?? "", helpful: d.review.helpful ?? 0, unhelpful: d.review.unhelpful ?? 0, updatedAt: d.review.updatedAt ?? 0 }
      : null,
    source: d.source ?? "manual",
    clickCount: d.clickCount ?? 0,
    createdAt: d.createdAt ?? 0,
    publishedAt: d.publishedAt ?? null,
  };
}

export interface NewItem {
  url: string;
  urlIsSearch: boolean;
  productKey: string | null;
  shop: string;
  shopLabel: string;
  title: string;
  imageUrl: string | null;
  price: number | null;
  category: Category;
  tags: string[];
  isAdult: boolean;
  visibility: Visibility;
  source: ImportSource;
}

/** Insert drafts, skipping products the user already has (by productKey). Returns created ids. */
export async function createDrafts(ownerUid: string, items: NewItem[]): Promise<string[]> {
  const keys = items.map((i) => i.productKey).filter((k): k is string => !!k);
  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += 30) {
    const snap = await itemsCol().where("ownerUid", "==", ownerUid).where("productKey", "in", keys.slice(i, i + 30)).select("productKey").get();
    snap.docs.forEach((d) => existing.add(d.get("productKey")));
  }
  const batch = db.batch();
  const ids: string[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  for (const it of items) {
    if (it.productKey && (existing.has(it.productKey) || seen.has(it.productKey))) continue;
    if (it.productKey) seen.add(it.productKey);
    const ref = itemsCol().doc();
    ids.push(ref.id);
    batch.set(ref, {
      ...it,
      ownerUid,
      status: "draft" satisfies ItemStatus,
      guard: null,
      note: "",
      review: null,
      clickCount: 0,
      createdAt: now,
      publishedAt: null,
    });
  }
  if (ids.length) await batch.commit();
  return ids;
}

export async function getItem(id: string): Promise<Item | null> {
  const snap = await itemsCol().doc(id).get();
  return snap.exists ? toItem(snap.id, snap.data()!) : null;
}

export async function getItems(ids: string[]): Promise<Item[]> {
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => itemsCol().doc(id)));
  return snaps.filter((s) => s.exists).map((s) => toItem(s.id, s.data()!));
}

export async function listDrafts(ownerUid: string): Promise<Item[]> {
  const snap = await itemsCol().where("ownerUid", "==", ownerUid).where("status", "==", "draft").orderBy("createdAt", "desc").limit(300).get();
  return snap.docs.map((d) => toItem(d.id, d.data()));
}

export async function listShelf(ownerUid: string, limit = 200): Promise<Item[]> {
  const snap = await itemsCol().where("ownerUid", "==", ownerUid).where("status", "==", "published").orderBy("publishedAt", "desc").limit(limit).get();
  return snap.docs.map((d) => toItem(d.id, d.data()));
}

/** Items from followed users, newest first. `in` queries are chunked by 30 owners. */
export async function listFeed(ownerUids: string[], limit = 60): Promise<Item[]> {
  const results: Item[] = [];
  for (let i = 0; i < ownerUids.length; i += 30) {
    const snap = await itemsCol()
      .where("ownerUid", "in", ownerUids.slice(i, i + 30))
      .where("status", "==", "published")
      .orderBy("publishedAt", "desc")
      .limit(limit)
      .get();
    results.push(...snap.docs.map((d) => toItem(d.id, d.data())));
  }
  return results.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)).slice(0, limit);
}

export async function listRecentPublic(limit = 40): Promise<Item[]> {
  const snap = await itemsCol().where("status", "==", "published").where("visibility", "==", "public").orderBy("publishedAt", "desc").limit(limit * 2).get();
  return snap.docs.map((d) => toItem(d.id, d.data())).filter((i) => !i.isAdult && !lacksProductInfo(i)).slice(0, limit);
}

export async function setGuard(results: { id: string; guard: GuardResult; isAdult?: boolean }[]) {
  const batch = db.batch();
  for (const r of results) {
    batch.update(itemsCol().doc(r.id), r.isAdult ? { guard: r.guard, isAdult: true } : { guard: r.guard });
  }
  await batch.commit();
}

/** Publish the given drafts owned by `ownerUid`, with per-item visibility. */
export async function publishItems(ownerUid: string, entries: { id: string; visibility: Visibility }[]) {
  const items = await getItems(entries.map((e) => e.id));
  // Items without a real title would show a broken card whose link is a members-only page.
  const owned = new Map(items.filter((i) => i.ownerUid === ownerUid && i.status === "draft" && !lacksProductInfo(i)).map((i) => [i.id, i]));
  const batch = db.batch();
  const now = Date.now();
  let n = 0;
  for (const e of entries) {
    if (!owned.has(e.id)) continue;
    batch.update(itemsCol().doc(e.id), { status: "published", visibility: e.visibility, publishedAt: now - n });
    n++;
  }
  if (n) {
    batch.update(db.collection("users").doc(ownerUid), { itemCount: FieldValue.increment(n) });
    await batch.commit();
  }
  return n;
}

/** Delete the given items owned by `ownerUid`. Returns the ids actually deleted. */
export async function deleteItems(ownerUid: string, ids: string[]): Promise<string[]> {
  const items = await getItems(ids);
  const owned = items.filter((i) => i.ownerUid === ownerUid);
  if (!owned.length) return [];
  const batch = db.batch();
  owned.forEach((i) => batch.delete(itemsCol().doc(i.id)));
  const publishedCount = owned.filter((i) => i.status === "published").length;
  if (publishedCount) batch.update(db.collection("users").doc(ownerUid), { itemCount: FieldValue.increment(-publishedCount) });
  await batch.commit();
  await deleteReactionsForItems(owned.filter((i) => i.review).map((i) => i.id));
  return owned.map((i) => i.id);
}

export async function updateItem(ownerUid: string, id: string, patch: Partial<Pick<Item, "visibility" | "note" | "title" | "category" | "isAdult" | "shelfCategory">>) {
  const ref = itemsCol().doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("ownerUid") !== ownerUid) throw new Error("not found");
    tx.update(ref, patch);
  });
}

/** Owner-entered title for an item whose product page could not be read, with its new shop link. */
export async function setItemProductInfo(
  ownerUid: string,
  id: string,
  patch: Pick<Item, "title" | "url" | "urlIsSearch" | "shop" | "shopLabel"> & { productKey: string | null },
) {
  const ref = itemsCol().doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("ownerUid") !== ownerUid) throw new Error("not found");
    tx.update(ref, { ...patch, guard: null });
  });
}

export async function incrementClick(id: string) {
  await itemsCol().doc(id).update({ clickCount: FieldValue.increment(1) });
}

export async function setItemTags(updates: { id: string; tags: string[] }[]) {
  for (let i = 0; i < updates.length; i += 400) {
    const batch = db.batch();
    updates.slice(i, i + 400).forEach((u) => batch.update(itemsCol().doc(u.id), { tags: u.tags }));
    await batch.commit();
  }
}

/** Change the visibility of several of the owner's items at once. Returns the number updated. */
export async function setItemsVisibility(ownerUid: string, ids: string[], visibility: Visibility): Promise<number> {
  const owned = (await getItems(ids)).filter((i) => i.ownerUid === ownerUid);
  for (let i = 0; i < owned.length; i += 400) {
    const batch = db.batch();
    owned.slice(i, i + 400).forEach((it) => batch.update(itemsCol().doc(it.id), { visibility }));
    await batch.commit();
  }
  return owned.length;
}
