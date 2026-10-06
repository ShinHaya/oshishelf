import "server-only";
import { FunctionTool, LlmAgent } from "@google/adk";
import { z } from "zod";
import { Type, type Schema } from "@google/genai";
import { adkModel, runAgentJson, type AgentStep } from "../adk";
import { embed } from "../gemini";
import { aiSafeItems } from "../../access";
import { listShelf } from "../../data/items";
import { setTasteVector, updateUser } from "../../data/users";
import type { AiBio, Item } from "../../types";
import { CATEGORY_LABELS } from "../../types";
import { itemBrief, searchShelf, shelfOverview, tasteText } from "./shelf-tools";

const INSTRUCTION = `あなたは購入履歴SNS「推し棚」のプロフィール作成エージェントです。
ユーザーの公開している購入履歴（棚）から趣味嗜好を推論し、同じ趣味の人が「話してみたい」と思う自己紹介文を作ります。

手順:
1. get_shelf_overview で全体傾向（カテゴリ・ショップ・タグ）を把握する
2. 気になる傾向について get_items_by_category や search_shelf で具体的な作品を確認する（2〜4回）
3. 推論した嗜好をもとに自己紹介文を書く

ルール:
- 一人称は「わたし」、親しみやすい口調。本文は120〜200文字。
- 具体的な作品名やジャンルを1〜3個入れる。
- 健康・宗教・政治・性的指向など、デリケートな属性は推測しない。性的な表現は使わない。
- 棚にない作品を捏造しない。

最後に次のJSONだけを出力してください:
{"catchphrase": "15文字程度のキャッチコピー", "bio": "自己紹介文", "traits": ["嗜好を表す短いタグ", ...5個]}`;

function buildAgent(items: Item[]) {
  return new LlmAgent({
    name: "profile_agent",
    model: adkModel(),
    instruction: INSTRUCTION,
    tools: [
      new FunctionTool({
        name: "get_shelf_overview",
        description: "棚全体の件数・カテゴリ別件数・ショップ別件数・よく付いているタグを返す",
        execute: () => shelfOverview(items),
      }),
      new FunctionTool({
        name: "get_items_by_category",
        description: "指定カテゴリの作品を新しい順に返す",
        parameters: z.object({
          category: z.enum(["book", "comic", "video", "game", "music", "goods", "other"]).describe("カテゴリ"),
          limit: z.number().int().min(1).max(30).default(15),
        }),
        execute: ({ category, limit }) => ({
          category: CATEGORY_LABELS[category],
          items: items.filter((i) => i.category === category).slice(0, limit).map(itemBrief),
        }),
      }),
      new FunctionTool({
        name: "search_shelf",
        description: "タイトル・タグのキーワードで棚を検索する",
        parameters: z.object({ query: z.string().describe("検索キーワード（スペース区切り可）") }),
        execute: ({ query }) => ({ items: searchShelf(items, query) }),
      }),
    ],
  });
}

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    catchphrase: { type: Type.STRING },
    bio: { type: Type.STRING },
    traits: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["catchphrase", "bio", "traits"],
};

/** Re-embed the user's public shelf for similarity search. */
export async function refreshTaste(uid: string, items?: Item[]): Promise<void> {
  const safe = aiSafeItems(items ?? (await listShelf(uid)));
  if (safe.length === 0) return;
  const [vector] = await embed([tasteText(safe)]);
  const tags = shelfOverview(safe).topTags.slice(0, 12).map((t) => t.tag);
  await setTasteVector(uid, vector, tags);
}

/** Generate the AI self-introduction from the public shelf (ADK agent with tools). */
export async function generateBio(uid: string): Promise<{ bio: AiBio; steps: AgentStep[] }> {
  const items = aiSafeItems(await listShelf(uid));
  if (items.length < 3) throw new Error("自己紹介を作るには、全体公開の作品が3件以上必要です");
  const { data: parsed, steps } = await runAgentJson<{ catchphrase: string; bio: string; traits: string[] }>(
    buildAgent(items),
    uid,
    "わたしの棚を分析して自己紹介文を作ってください。",
    SCHEMA,
    "bio は一人称「わたし」の120〜200文字の自己紹介文。",
  );
  const bio: AiBio = {
    text: String(parsed.bio).slice(0, 400),
    catchphrase: String(parsed.catchphrase ?? "").slice(0, 40),
    traits: (parsed.traits ?? []).map(String).slice(0, 6),
    generatedAt: Date.now(),
  };
  // Saved as a draft: the user reviews and edits it before it appears on their profile.
  await updateUser(uid, { aiBioDraft: bio });
  await refreshTaste(uid, items);
  return { bio, steps };
}
