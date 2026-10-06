import "server-only";
import { FunctionTool, LlmAgent } from "@google/adk";
import { z } from "zod";
import { adkModel, runAgent, type AgentStep } from "../adk";
import { ADULT_GUIDANCE, TWIN_ADULT_GUARD } from "../adult-policy";
import { SAFETY_SETTINGS } from "../gemini";
import { adultAiAllowed, aiItems } from "../../access";
import { listShelf } from "../../data/items";
import type { Item, UserProfile } from "../../types";
import { itemBrief, searchShelf, shelfOverview } from "./shelf-tools";

export interface ChatTurn {
  role: "user" | "twin";
  text: string;
}

function buildAgent(owner: UserProfile, items: Item[], visitorName: string, includeAdult: boolean) {
  const bio = includeAdult && owner.aiBio?.adult ? owner.aiBio.adult.text : owner.aiBio?.text;
  return new LlmAgent({
    name: "twin_agent",
    model: adkModel(),
    generateContentConfig: { safetySettings: SAFETY_SETTINGS },
    instruction: `あなたは「${owner.displayName}」(@${owner.handle}) さんの公開購入履歴から作られたAI分身です。
話し相手は ${visitorName} さんです。${owner.displayName} さん本人になりきって、フレンドリーな一人称（わたし）で答えてください。

${bio ? `本人の自己紹介: ${bio}` : ""}

棚の作品一覧（id: タイトル）:
${items
  .slice(0, 80)
  .map((i) => `- ${i.id}: ${i.title}${i.isAdult && i.tags.length ? `［ジャンル: ${i.tags.join("、")}］` : ""}`)
  .join("\n")}

ルール:
- 作品の詳しい情報（ジャンル・タグ）が必要なときは search_shelf / get_shelf_overview / list_recent ツールで確認する。
- 棚にある作品だけを根拠にする。持っていない作品を持っているふりをしない。分からないことは「棚からは分からないなあ」と言う。
- おすすめする作品は文中に [[item:作品id]] の形式で埋め込む（1回の返答で最大3つ）。id は上の一覧にあるものだけを使う。マーカーは画面上で『作品名』のリンクに置き換わるので、作品名を別に書かない（例:「それなら [[item:abc123]] がおすすめ！」）。
- 住所・本名・年齢などの個人情報や、デリケートな話題には答えない。性的な表現は使わない。
- 自分がAI分身であることを聞かれたら正直に認める。
- 返答は200文字程度まで。${includeAdult ? `\n\n${ADULT_GUIDANCE}\n${TWIN_ADULT_GUARD}` : ""}`,
    tools: [
      new FunctionTool({
        name: "get_shelf_overview",
        description: "棚全体の傾向（カテゴリ・ショップ・タグ）",
        execute: () => shelfOverview(items),
      }),
      new FunctionTool({
        name: "search_shelf",
        description: "棚をキーワード検索（タイトル・タグ・カテゴリ）",
        parameters: z.object({ query: z.string() }),
        execute: ({ query }) => ({ items: searchShelf(items, query, 10) }),
      }),
      new FunctionTool({
        name: "list_recent",
        description: "最近棚に追加した作品",
        parameters: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
        execute: ({ limit }) => ({ items: items.slice(0, limit).map(itemBrief) }),
      }),
    ],
  });
}

/** One chat turn with the owner's AI twin. History is kept client-side and replayed (stateless on Cloud Run). */
export async function chatWithTwin(owner: UserProfile, visitor: UserProfile, history: ChatTurn[], message: string): Promise<{ reply: string; items: Item[]; steps: AgentStep[] }> {
  const visitorName = visitor.displayName;
  const visitorUid = visitor.uid;
  // R18 items join the conversation only if the owner allowed AI use and the visitor opted in to R18 display.
  const includeAdult = adultAiAllowed(owner, visitor);
  const shelf = await listShelf(owner.uid);
  const items = aiItems(shelf, includeAdult);
  const transcript = history
    .slice(-10)
    .map((t) => `${t.role === "user" ? visitorName : "あなた"}: ${t.text.slice(0, 500)}`)
    .join("\n");
  const prompt = `${transcript ? `これまでの会話:\n${transcript}\n\n` : ""}${visitorName}: ${message.slice(0, 500)}`;
  const { text, steps } = await runAgent(buildAgent(owner, items, visitorName, includeAdult), visitorUid, prompt);
  // Render with real items (the visitor may see them); the model only saw the redacted versions.
  const allowed = new Set(items.map((i) => i.id));
  const byId = new Map(shelf.filter((i) => allowed.has(i.id)).map((i) => [i.id, i]));
  // Drop markers that don't point at a real shelf item instead of leaving a hole in the sentence.
  const reply = text.replace(/\[\[item:([A-Za-z0-9]+)\]\]/g, (m, id) => (byId.has(id) ? m : ""));
  const ids = [...reply.matchAll(/\[\[item:([A-Za-z0-9]+)\]\]/g)].map((m) => m[1]);
  return { reply, items: [...new Set(ids)].map((id) => byId.get(id)!), steps };
}
