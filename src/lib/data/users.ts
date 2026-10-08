import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase-admin";
import type { UserProfile } from "../types";

export const usersCol = () => db.collection("users");

export function toProfile(id: string, d: FirebaseFirestore.DocumentData): UserProfile {
  return {
    uid: id,
    handle: d.handle,
    displayName: d.displayName ?? d.handle,
    bio: d.bio ?? "",
    aiBio: d.aiBio ?? null,
    aiBioDraft: d.aiBioDraft ?? null,
    avatarHue: d.avatarHue ?? 200,
    isAdult: !!d.isAdult,
    showAdult: !!d.showAdult,
    aiUseAdult: !!d.aiUseAdult,
    defaultVisibility: d.defaultVisibility ?? "public",
    twinEnabled: d.twinEnabled ?? true,
    tasteTags: d.tasteTags ?? [],
    followerCount: d.followerCount ?? 0,
    followingCount: d.followingCount ?? 0,
    itemCount: d.itemCount ?? 0,
    createdAt: d.createdAt ?? 0,
  };
}

export async function getUser(uid: string): Promise<UserProfile | null> {
  const snap = await usersCol().doc(uid).get();
  return snap.exists ? toProfile(snap.id, snap.data()!) : null;
}

export async function getUserByHandle(handle: string): Promise<UserProfile | null> {
  const h = await db.collection("handles").doc(handle.toLowerCase()).get();
  if (!h.exists) return null;
  return getUser(h.data()!.uid);
}

export async function getUsers(uids: string[]): Promise<Map<string, UserProfile>> {
  const unique = [...new Set(uids)];
  if (unique.length === 0) return new Map();
  const snaps = await db.getAll(...unique.map((u) => usersCol().doc(u)));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, toProfile(s.id, s.data()!)]));
}

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** Create a profile with a unique handle (transactional reservation). */
export async function createUser(uid: string, input: { handle: string; displayName: string; isAdult: boolean }) {
  const handle = input.handle.toLowerCase();
  if (!HANDLE_RE.test(handle)) throw new Error("ハンドルは半角英小文字・数字・_ の3〜20文字にしてください");
  await db.runTransaction(async (tx) => {
    const hRef = db.collection("handles").doc(handle);
    const uRef = usersCol().doc(uid);
    const [h, u] = await Promise.all([tx.get(hRef), tx.get(uRef)]);
    if (u.exists) throw new Error("すでにプロフィールが作成されています");
    if (h.exists) throw new Error("そのハンドルは使われています");
    tx.set(hRef, { uid });
    tx.set(uRef, {
      handle,
      displayName: input.displayName.slice(0, 40),
      bio: "",
      aiBio: null,
      aiBioDraft: null,
      avatarHue: Math.floor(Math.random() * 360),
      isAdult: input.isAdult,
      showAdult: false,
      aiUseAdult: false,
      defaultVisibility: "public",
      twinEnabled: true,
      tasteTags: [],
      followerCount: 0,
      followingCount: 0,
      itemCount: 0,
      createdAt: Date.now(),
    });
  });
}

export async function updateUser(uid: string, patch: Partial<Omit<UserProfile, "uid" | "handle">>) {
  await usersCol().doc(uid).update(patch);
}

/** Owner-defined shelf category names, kept apart from the profile so they never reach other viewers' pages. */
export const MAX_SHELF_CATEGORIES = 50;

export async function getShelfCategories(uid: string): Promise<string[]> {
  const snap = await usersCol().doc(uid).get();
  return (snap.get("shelfCategories") as string[] | undefined) ?? [];
}

export async function addShelfCategory(uid: string, name: string) {
  const ref = usersCol().doc(uid);
  await db.runTransaction(async (tx) => {
    const current = ((await tx.get(ref)).get("shelfCategories") as string[] | undefined) ?? [];
    if (current.includes(name)) return;
    if (current.length >= MAX_SHELF_CATEGORIES) throw new Error(`カテゴリーは${MAX_SHELF_CATEGORIES}個までです`);
    tx.update(ref, { shelfCategories: FieldValue.arrayUnion(name) });
  });
}

export async function removeShelfCategory(uid: string, name: string) {
  await usersCol().doc(uid).update({ shelfCategories: FieldValue.arrayRemove(name) });
}

export async function setTasteVector(uid: string, vector: number[], tags: string[]) {
  await usersCol().doc(uid).update({ tasteVector: FieldValue.vector(vector), tasteTags: tags, tasteUpdatedAt: Date.now() });
}

export async function getTasteVector(uid: string): Promise<number[] | null> {
  const snap = await usersCol().doc(uid).get();
  const v = snap.get("tasteVector");
  return v ? (v.toArray() as number[]) : null;
}

/** Users whose taste vector is nearest to `vector` (Firestore vector search). */
export async function findSimilarUsers(vector: number[], limit = 10): Promise<{ profile: UserProfile; distance: number }[]> {
  const snap = await usersCol()
    .findNearest({ vectorField: "tasteVector", queryVector: vector, limit, distanceMeasure: "COSINE", distanceResultField: "_distance" })
    .get();
  return snap.docs.map((d) => ({ profile: toProfile(d.id, d.data()), distance: d.get("_distance") as number }));
}

export async function listRecentUsers(limit = 20): Promise<UserProfile[]> {
  const snap = await usersCol().orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs.map((d) => toProfile(d.id, d.data()));
}
