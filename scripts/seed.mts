/**
 * Seeds demo users with all-ages shelves so the social / matching features can be tried immediately.
 * Usage: BOOKS_API_KEY=... node scripts/seed.mts
 * Requires ADC (gcloud auth application-default login) with access to the project.
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "oshishelf-hackathon";
const BOOKS_KEY = process.env.BOOKS_API_KEY;
if (!BOOKS_KEY) throw new Error("BOOKS_API_KEY is required");

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const auth = getAuth();
const db = getFirestore();
const genai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: "global" });

type Cat = "book" | "comic" | "game";
interface SeedUser {
  email: string;
  /** Only the public demo account can sign in; sample users have no password. */
  password?: string;
  handle: string;
  displayName: string;
  hue: number;
  shelf: { q: string; cat: Cat; tags: string[] }[];
  /** Pre-generate the AI bio (the demo account leaves it empty so it can be generated live). */
  withBio: boolean;
}

const USERS: SeedUser[] = [
  {
    email: "demo@oshishelf.app",
    password: "oshishelf-demo-2026",
    handle: "demo",
    displayName: "デモ太郎",
    hue: 340,
    withBio: false,
    shelf: [
      { q: "葬送のフリーレン", cat: "comic", tags: ["ファンタジー", "旅もの", "サンデー"] },
      { q: "ダンジョン飯", cat: "comic", tags: ["ファンタジー", "グルメ", "ダンジョン"] },
      { q: "チェンソーマン", cat: "comic", tags: ["ダークファンタジー", "ジャンプ"] },
      { q: "薬屋のひとりごと", cat: "comic", tags: ["後宮", "ミステリー"] },
      { q: "本好きの下剋上", cat: "book", tags: ["異世界", "ライトノベル", "ビブリオ"] },
      { q: "三体", cat: "book", tags: ["SF", "中国SF"] },
      { q: "steam:Hades", cat: "game", tags: ["ローグライク", "インディー", "ギリシャ神話"] },
      { q: "steam:Stardew Valley", cat: "game", tags: ["スローライフ", "インディー"] },
    ],
  },
  {
    email: "mika@oshishelf.app",
    handle: "mika_reads",
    displayName: "みか",
    hue: 20,
    withBio: true,
    shelf: [
      { q: "葬送のフリーレン", cat: "comic", tags: ["ファンタジー", "旅もの"] },
      { q: "ダンジョン飯", cat: "comic", tags: ["ファンタジー", "グルメ"] },
      { q: "魔法使いの嫁", cat: "comic", tags: ["ファンタジー", "英国"] },
      { q: "とんがり帽子のアトリエ", cat: "comic", tags: ["ファンタジー", "魔法"] },
      { q: "ふしぎ駄菓子屋 銭天堂", cat: "book", tags: ["児童書", "ファンタジー"] },
      { q: "十二国記", cat: "book", tags: ["ファンタジー", "異世界"] },
      { q: "獣の奏者", cat: "book", tags: ["ファンタジー", "上橋菜穂子"] },
      { q: "ハクメイとミコチ", cat: "comic", tags: ["ファンタジー", "日常", "スローライフ"] },
    ],
  },
  {
    email: "kenji@oshishelf.app",
    handle: "kenji_games",
    displayName: "けんじ",
    hue: 200,
    withBio: true,
    shelf: [
      { q: "steam:Hades", cat: "game", tags: ["ローグライク", "インディー"] },
      { q: "steam:Hollow Knight", cat: "game", tags: ["メトロイドヴァニア", "インディー"] },
      { q: "steam:Celeste", cat: "game", tags: ["アクション", "インディー"] },
      { q: "steam:Slay the Spire", cat: "game", tags: ["デッキ構築", "ローグライク"] },
      { q: "steam:Outer Wilds", cat: "game", tags: ["探索", "SF", "インディー"] },
      { q: "steam:Stardew Valley", cat: "game", tags: ["スローライフ", "インディー"] },
      { q: "ゲームの歴史", cat: "book", tags: ["ゲーム史", "ノンフィクション"] },
    ],
  },
  {
    email: "tetsu@oshishelf.app",
    handle: "tetsu_sf",
    displayName: "てつ",
    hue: 260,
    withBio: true,
    shelf: [
      { q: "三体", cat: "book", tags: ["SF", "中国SF"] },
      { q: "プロジェクト・ヘイル・メアリー", cat: "book", tags: ["SF", "宇宙"] },
      { q: "火星の人", cat: "book", tags: ["SF", "サバイバル"] },
      { q: "あなたの人生の物語", cat: "book", tags: ["SF", "短編集"] },
      { q: "虐殺器官", cat: "book", tags: ["SF", "伊藤計劃"] },
      { q: "steam:Outer Wilds", cat: "game", tags: ["探索", "SF"] },
      { q: "宇宙兄弟", cat: "comic", tags: ["宇宙", "青春"] },
    ],
  },
  {
    email: "yuki@oshishelf.app",
    handle: "yuki_gourmet",
    displayName: "ゆき",
    hue: 90,
    withBio: true,
    shelf: [
      { q: "ダンジョン飯", cat: "comic", tags: ["グルメ", "ファンタジー"] },
      { q: "孤独のグルメ", cat: "comic", tags: ["グルメ", "食べ歩き"] },
      { q: "きのう何食べた?", cat: "comic", tags: ["グルメ", "料理", "日常"] },
      { q: "ワカコ酒", cat: "comic", tags: ["グルメ", "お酒"] },
      { q: "銀の匙", cat: "comic", tags: ["農業", "青春"] },
      { q: "おいしいごはんが食べられますように", cat: "book", tags: ["小説", "芥川賞"] },
      { q: "steam:Stardew Valley", cat: "game", tags: ["スローライフ", "農業"] },
    ],
  },
];

async function lookupBook(q: string) {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `intitle:${q}`);
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("langRestrict", "ja");
  url.searchParams.set("key", BOOKS_KEY!);
  const data = await (await fetch(url)).json();
  const hit = (data.items ?? []).find((i: { volumeInfo: { imageLinks?: unknown; title: string } }) => i.volumeInfo.imageLinks && i.volumeInfo.title.includes(q.slice(0, 3)));
  const v = hit?.volumeInfo;
  return {
    title: v?.title ?? q,
    imageUrl: v?.imageLinks?.thumbnail ? String(v.imageLinks.thumbnail).replace("http://", "https://").replace("&edge=curl", "") : null,
    url: `https://www.amazon.co.jp/s?k=${encodeURIComponent(v?.title ?? q)}`,
    urlIsSearch: true,
    shop: "amazon",
    shopLabel: "Amazon",
    price: null as number | null,
  };
}

async function lookupSteam(q: string) {
  const data = await (await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&cc=jp&l=japanese`)).json();
  const hit = data.items?.find((i: { name: string }) => i.name.toLowerCase() === q.toLowerCase()) ?? data.items?.[0];
  if (!hit) throw new Error(`steam not found: ${q}`);
  return {
    title: hit.name as string,
    imageUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${hit.id}/header.jpg`,
    url: `https://store.steampowered.com/app/${hit.id}/`,
    urlIsSearch: false,
    shop: "steam",
    shopLabel: "Steam",
    price: hit.price?.final ? Math.round(hit.price.final / 100) : null,
  };
}

async function ensureAuthUser(u: SeedUser): Promise<string> {
  try {
    return (await auth.getUserByEmail(u.email)).uid;
  } catch {
    return (await auth.createUser({ email: u.email, ...(u.password ? { password: u.password } : {}), emailVerified: true })).uid;
  }
}

async function wipeUser(uid: string) {
  const items = await db.collection("items").where("ownerUid", "==", uid).get();
  const batch = db.batch();
  items.docs.forEach((d) => batch.delete(d.ref));
  for (const sub of ["wishes", "notifications"]) {
    (await db.collection("users").doc(uid).collection(sub).get()).docs.forEach((d) => batch.delete(d.ref));
  }
  (await db.collection("follows").where("follower", "==", uid).get()).docs.forEach((d) => batch.delete(d.ref));
  (await db.collection("follows").where("followee", "==", uid).get()).docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

async function embedTaste(text: string) {
  const res = await genai.models.embedContent({ model: "gemini-embedding-001", contents: [text], config: { outputDimensionality: 768, taskType: "SEMANTIC_SIMILARITY" } });
  const v = res.embeddings![0].values!;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

async function makeBio(name: string, titles: string[], tags: string[]) {
  const res = await genai.models.generateContent({
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    contents: `購入履歴SNSのユーザー「${name}」の棚: ${titles.join("、")}。タグ: ${tags.join("、")}。
一人称「わたし」で120〜180文字の親しみやすい自己紹介と、15文字程度のキャッチコピー、嗜好タグ5つを作って。JSONで {"catchphrase":"","bio":"","traits":[]}`,
    config: { responseMimeType: "application/json", temperature: 0.7 },
  });
  return JSON.parse(res.text!) as { catchphrase: string; bio: string; traits: string[] };
}

const uids = new Map<string, string>();
for (const u of USERS) {
  const uid = await ensureAuthUser(u);
  uids.set(u.handle, uid);
  await wipeUser(uid);
  console.log(`user ${u.handle} (${uid})`);

  const now = Date.now();
  const items = [];
  for (const [i, s] of u.shelf.entries()) {
    const meta = s.q.startsWith("steam:") ? await lookupSteam(s.q.slice(6)) : await lookupBook(s.q);
    const ref = db.collection("items").doc();
    const doc = {
      ownerUid: uid,
      ...meta,
      productKey: `seed:${meta.title}`,
      category: s.cat,
      tags: s.tags,
      isAdult: false,
      visibility: "public",
      status: "published",
      guard: { level: "ok", reasons: [], suggestedVisibility: "public", checkedAt: now },
      note: "",
      source: "manual",
      clickCount: 0,
      createdAt: now - i * 3_600_000,
      publishedAt: now - i * 3_600_000 - Math.floor(Math.random() * 600_000),
    };
    await ref.set(doc);
    items.push(doc);
    console.log(`  + ${meta.title}`);
  }

  const tags = [...new Set(items.flatMap((i) => i.tags))];
  const vector = await embedTaste(`カテゴリ: ${[...new Set(items.map((i) => i.category))].join(" ")}\nタグ: ${tags.join(" ")}\n作品: ${items.map((i) => i.title).join(" / ")}`);
  const bio = u.withBio ? await makeBio(u.displayName, items.map((i) => i.title), tags) : null;

  await db.collection("handles").doc(u.handle).set({ uid });
  await db.collection("users").doc(uid).set({
    handle: u.handle,
    displayName: u.displayName,
    bio: "",
    aiBio: bio ? { text: bio.bio, catchphrase: bio.catchphrase, traits: bio.traits.slice(0, 6), generatedAt: now } : null,
    aiBioDraft: null,
    avatarHue: u.hue,
    isAdult: false,
    showAdult: false,
    defaultVisibility: "public",
    twinEnabled: true,
    tasteTags: tags.slice(0, 12),
    tasteVector: FieldValue.vector(vector),
    followerCount: 0,
    followingCount: 0,
    itemCount: items.length,
    hasWatch: false,
    createdAt: now - Math.floor(Math.random() * 86_400_000 * 10),
  });
}

// Social graph: demo follows two people; others follow demo.
const follows: [string, string][] = [
  ["demo", "mika_reads"],
  ["demo", "kenji_games"],
  ["mika_reads", "demo"],
  ["kenji_games", "demo"],
  ["yuki_gourmet", "demo"],
  ["tetsu_sf", "kenji_games"],
];
for (const [a, b] of follows) {
  const fa = uids.get(a)!;
  const fb = uids.get(b)!;
  await db.collection("follows").doc(`${fa}_${fb}`).set({ follower: fa, followee: fb, createdAt: Date.now() });
  await db.collection("users").doc(fa).update({ followingCount: FieldValue.increment(1) });
  await db.collection("users").doc(fb).update({ followerCount: FieldValue.increment(1) });
}
console.log("done");
process.exit(0);
