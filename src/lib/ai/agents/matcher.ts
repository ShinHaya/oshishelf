import "server-only";
import { FunctionTool, LlmAgent } from "@google/adk";
import { z } from "zod";
import { Type, type Schema } from "@google/genai";
import { adkModel, runAgentJson, type AgentStep } from "../adk";
import { adultAiAllowed, aiItems, canSeeAdult } from "../../access";
import { ADULT_GUIDANCE } from "../adult-policy";
import { SAFETY_SETTINGS } from "../gemini";
import { db } from "../../firebase-admin";
import { listShelf } from "../../data/items";
import { listFollowing } from "../../data/social";
import { findSimilarUsers, getTasteVector } from "../../data/users";
import type { Item, UserProfile } from "../../types";
import { itemBrief, searchShelf, shelfOverview } from "./shelf-tools";

export interface Compatibility {
  score: number;
  summary: string;
  sharedPoints: string[];
  picks: { itemId: string; title?: string; reason: string }[];
  icebreakers: string[];
  generatedAt: number;
  steps: AgentStep[];
}

const INSTRUCTION = `あなたは購入履歴SNS「推し棚」の相性分析エージェントです。
「わたし（閲覧者）」と「相手」の公開棚を比べ、趣味の相性を分析します。

手順:
1. compare_shelves で共通点と相違点を把握する
2. 必要に応じて search_their_shelf / search_my_shelf で具体的な作品を確認する
3. 相手の棚から「わたしが好きそうだけどまだ持っていない」作品を最大3つ選ぶ（item id は相手の棚に実在するものだけ）。
   reason は閲覧者に向けて「あなたは○○が好きなので〜」の形で書く。
4. 閲覧者が相手に送る最初のメッセージ例を2つ考える（相手の名前を使い、プレースホルダーは使わない）

ルール: デリケートな属性を推測しない。性的な表現は使わない。棚にない作品を捏造しない。

最後に次のJSONだけを出力してください:
{"score": 0〜100の整数, "summary": "相性の一言説明（60文字以内）", "sharedPoints": ["共通点", ...最大4], "picks": [{"itemId": "相手の作品id", "reason": "おすすめ理由"}], "icebreakers": ["話しかけ例", "話しかけ例"]}`;

function buildAgent(mine: Item[], theirs: Item[], viewerName: string, targetName: string) {
  // Redacted R18 items share a placeholder title, so they never count as "same work".
  const sameKey = (i: Item) => (i.isAdult ? `adult:${i.id}` : i.title);
  const myTitles = new Set(mine.map(sameKey));
  const includeAdult = [...mine, ...theirs].some((i) => i.isAdult);
  return new LlmAgent({
    name: "match_agent",
    model: adkModel(),
    instruction: `${INSTRUCTION}\n\n閲覧者（わたし）: ${viewerName} さん / 相手: ${targetName} さん${includeAdult ? `\n\n${ADULT_GUIDANCE}` : ""}`,
    generateContentConfig: { safetySettings: SAFETY_SETTINGS },
    tools: [
      new FunctionTool({
        name: "compare_shelves",
        description: "2人の棚の傾向と、共通するタグ・カテゴリ・同じ作品を返す",
        execute: () => {
          const a = shelfOverview(mine);
          const b = shelfOverview(theirs);
          const tagsA = new Set(a.topTags.map((t) => t.tag));
          return {
            me: a,
            them: b,
            sharedTags: b.topTags.filter((t) => tagsA.has(t.tag)).map((t) => t.tag),
            sameItems: theirs.filter((i) => myTitles.has(sameKey(i))).slice(0, 10).map((i) => i.title),
          };
        },
      }),
      new FunctionTool({
        name: "search_their_shelf",
        description: "相手の棚をキーワード検索する。わたしが持っていない作品には notOwnedByMe=true が付く",
        parameters: z.object({ query: z.string() }),
        execute: ({ query }) => ({ items: searchShelf(theirs, query).map((x) => ({ ...x, notOwnedByMe: !x.adult && !myTitles.has(x.title) })) }),
      }),
      new FunctionTool({
        name: "search_my_shelf",
        description: "わたしの棚をキーワード検索する",
        parameters: z.object({ query: z.string() }),
        execute: ({ query }) => ({ items: searchShelf(mine, query) }),
      }),
      new FunctionTool({
        name: "list_their_recent",
        description: "相手の最近の作品を返す",
        execute: () => ({ items: theirs.slice(0, 25).map((i) => ({ ...itemBrief(i), notOwnedByMe: !myTitles.has(sameKey(i)) })) }),
      }),
    ],
  });
}

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.INTEGER },
    summary: { type: Type.STRING },
    sharedPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
    picks: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { itemId: { type: Type.STRING }, reason: { type: Type.STRING } }, required: ["itemId", "reason"] } },
    icebreakers: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["score", "summary", "sharedPoints", "picks", "icebreakers"],
};

const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

/**
 * Which R18 items may inform this analysis: the viewer's own (if they opted in to both R18 display and
 * AI use) and the target's (if the target allowed AI use and the viewer opted in to R18 display).
 */
export function compatScope(viewer: UserProfile, target: UserProfile) {
  const mineAdult = viewer.isAdult && viewer.aiUseAdult && canSeeAdult(viewer);
  const theirsAdult = adultAiAllowed(target, viewer);
  return { mineAdult, theirsAdult, docId: `${viewer.uid}_${target.uid}_${mineAdult || theirsAdult ? "adult" : "safe"}` };
}

/** Explain viewer ↔ target compatibility with an ADK agent; cached per scope for a day. */
export async function analyzeCompatibility(viewer: UserProfile, target: UserProfile, force = false): Promise<Compatibility> {
  const scope = compatScope(viewer, target);
  const ref = db.collection("compat").doc(scope.docId);
  if (!force) {
    const cached = await ref.get();
    if (cached.exists && Date.now() - cached.get("generatedAt") < CACHE_TTL_MS) return cached.data() as Compatibility;
  }
  const [myShelf, theirShelf] = await Promise.all([listShelf(viewer.uid), listShelf(target.uid)]);
  const mine = aiItems(myShelf, scope.mineAdult);
  const theirs = aiItems(theirShelf, scope.theirsAdult);
  if (mine.length === 0 || theirs.length === 0) throw new Error("相性分析には、お互いに全体公開の作品が必要です");

  const { data: p, steps } = await runAgentJson<Omit<Compatibility, "generatedAt" | "steps">>(
    buildAgent(mine, theirs, viewer.displayName, target.displayName),
    viewer.uid,
    "わたしと相手の相性を分析してください。",
    SCHEMA,
    "picks の itemId は相手の棚に実在する id（ツール結果の id）だけを使い、わたしが持っていない作品にしてください。性的な描写や露骨な語は含めないでください。",
  );
  // Real titles for display (the viewer is allowed to see these items); the model only saw redacted ones.
  const theirRealById = new Map(theirShelf.filter((i) => theirs.some((t) => t.id === i.id)).map((i) => [i.id, i]));
  const result: Compatibility = {
    score: Math.max(0, Math.min(100, Math.round(Number(p.score) || 0))),
    summary: String(p.summary ?? "").slice(0, 120),
    sharedPoints: (p.sharedPoints ?? []).map(String).slice(0, 4),
    // Drop any hallucinated ids.
    picks: (p.picks ?? [])
      .filter((x) => theirRealById.has(x.itemId))
      .slice(0, 3)
      .map((x) => ({ itemId: x.itemId, title: theirRealById.get(x.itemId)!.title, reason: String(x.reason) })),
    icebreakers: (p.icebreakers ?? []).map(String).slice(0, 2),
    generatedAt: Date.now(),
    steps,
  };
  await ref.set({ ...result, viewerUid: viewer.uid, targetUid: target.uid });
  return result;
}

export async function getCachedCompatibility(viewer: UserProfile, target: UserProfile): Promise<Compatibility | null> {
  const snap = await db.collection("compat").doc(compatScope(viewer, target).docId).get();
  return snap.exists ? (snap.data() as Compatibility) : null;
}

/** Vector-search users with a similar taste, excluding self and people already followed. */
export async function recommendUsers(uid: string, limit = 8): Promise<{ profile: UserProfile; similarity: number }[]> {
  const vector = await getTasteVector(uid);
  if (!vector) return [];
  const [similar, following] = await Promise.all([findSimilarUsers(vector, limit + 20), listFollowing(uid)]);
  const exclude = new Set([uid, ...following]);
  return similar
    .filter((s) => !exclude.has(s.profile.uid))
    .slice(0, limit)
    .map((s) => ({ profile: s.profile, similarity: Math.round((1 - s.distance) * 100) }));
}
