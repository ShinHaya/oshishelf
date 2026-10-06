import "server-only";
import { Type, type Schema } from "@google/genai";
import { generateJson, LITE_MODEL } from "../gemini";
import { getItems, setGuard } from "../../data/items";
import type { GuardLevel, GuardResult, Item, Visibility } from "../../types";

const schema: Schema = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          i: { type: Type.INTEGER },
          level: { type: Type.STRING, enum: ["ok", "warn", "block"] },
          reasons: { type: Type.ARRAY, items: { type: Type.STRING }, description: "ユーザーに見せる短い理由（日本語）" },
          suggestedVisibility: { type: Type.STRING, enum: ["public", "followers", "private"] },
          adult: { type: Type.BOOLEAN },
        },
        required: ["i", "level", "reasons", "suggestedVisibility", "adult"],
      },
    },
  },
  required: ["results"],
};

const SYSTEM = `あなたは購入履歴SNS「推し棚」のプライバシーガードです。
ユーザーが購入履歴を公開する前に、公開すると本人が困る可能性のある商品を検出します。

判定基準:
- block: 個人情報（人名・「○○様」などの宛名・住所・電話番号・注文番号・メールアドレス）がタイトルに含まれる、明らかに商品ではない行
- warn: 健康・医療・妊娠・性的指向・宗教・政治・借金/金融トラブル・体型/コンプレックス・処方薬に関わる商品、成人向け商品、ギフト（贈り先が推測される）、職場や本名が推測される専門書
- ok: 上記以外の一般的な趣味の商品

suggestedVisibility は warn なら "followers" か "private"、block なら "private"、ok なら "public"。
理由は「健康に関する商品です」のように本人に優しく、短く書いてください。過剰に警告しないでください。`;

/**
 * Privacy guard: classify drafts before publishing so the user can review risky ones.
 * R18-shop items are flagged deterministically and their titles are never sent to the model.
 * Returns the number of items flagged warn/block.
 */
export async function runPrivacyGuard(uid: string, itemIds: string[]): Promise<number> {
  const items = (await getItems(itemIds)).filter((i) => i.ownerUid === uid);
  const results: { id: string; guard: GuardResult; isAdult?: boolean }[] = [];
  const toModel: Item[] = [];

  for (const it of items) {
    if (/^https?:\/\//.test(it.title)) {
      results.push({ id: it.id, guard: guard("warn", ["商品情報を取得できませんでした。URLが正しいか確認してください"], it.visibility) });
    } else if (it.isAdult) {
      results.push({ id: it.id, guard: guard("warn", ["成人向け（R18）作品です。18歳以上と申告し表示をONにした人にだけ表示されます"], "followers") });
    } else {
      toModel.push(it);
    }
  }

  for (let start = 0; start < toModel.length; start += 40) {
    const chunk = toModel.slice(start, start + 40);
    try {
      const out = await generateJson<{ results: { i: number; level: GuardLevel; reasons: string[]; suggestedVisibility: Visibility; adult: boolean }[] }>({
        model: LITE_MODEL,
        system: SYSTEM,
        parts: [{ text: JSON.stringify(chunk.map((it, i) => ({ i, title: it.title, shop: it.shopLabel, category: it.category, tags: it.tags }))) }],
        schema,
      });
      const byIndex = new Map(out.results.map((r) => [r.i, r]));
      chunk.forEach((it, i) => {
        const r = byIndex.get(i);
        if (!r) return results.push({ id: it.id, guard: guard("ok", [], it.visibility) });
        if (r.adult) {
          results.push({ id: it.id, guard: guard("warn", ["成人向けの可能性があります", ...r.reasons], "followers"), isAdult: true });
        } else {
          results.push({ id: it.id, guard: guard(r.level, r.reasons, r.suggestedVisibility) });
        }
      });
    } catch {
      // If the guard cannot run, fail closed: ask the user to review everything.
      chunk.forEach((it) => results.push({ id: it.id, guard: guard("warn", ["AIチェックが完了しませんでした。内容を確認してください"], "private") }));
    }
  }

  if (results.length) await setGuard(results);
  return results.filter((r) => r.guard.level !== "ok").length;
}

function guard(level: GuardLevel, reasons: string[], suggestedVisibility: Visibility): GuardResult {
  return { level, reasons: reasons.slice(0, 3), suggestedVisibility, checkedAt: Date.now() };
}
