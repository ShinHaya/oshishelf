import "server-only";
import { Type, type Schema } from "@google/genai";
import { generateJson, LITE_MODEL } from "../gemini";
import { canonicalizeUrl, detectShop, looksLikeProductUrl, shopSearchUrl } from "../../shops";
import { fetchProductMeta, readProductWithGemini } from "../../product-meta";
import { createDrafts, type NewItem } from "../../data/items";
import type { Category, ImportCandidate, ImportSource, Visibility } from "../../types";
import { runPrivacyGuard } from "./guard";

const MAX_ITEMS_PER_IMPORT = 80;

const listSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "商品名（巻数・版を含む正式名称）" },
          shop: { type: Type.STRING, description: "購入したショップ名。分からなければ空文字" },
          price: { type: Type.NUMBER, nullable: true },
          url: { type: Type.STRING, nullable: true, description: "テキスト中に商品URLがあればそのURL" },
        },
        required: ["title", "shop"],
      },
    },
  },
  required: ["items"],
};

type Extracted = { items: { title: string; shop: string; price?: number | null; url?: string | null }[] };

const EXTRACT_SYSTEM = `あなたはECサイトの購入履歴を読み取るアシスタントです。
購入した「商品」だけを列挙し、広告・おすすめ・ナビゲーション・注文番号・配送先・氏名・住所・カード情報などは絶対に含めないでください。
商品名の中に贈り先・宛名・氏名・メッセージが含まれている場合は、その部分を取り除いた商品名にしてください。
同じ商品は1回だけ出力してください。`;

/** Screenshot of a purchase-history page → product candidates (Gemini multimodal). */
export async function extractFromScreenshot(base64: string, mimeType: string): Promise<ImportCandidate[]> {
  const out = await generateJson<Extracted>({
    system: EXTRACT_SYSTEM,
    parts: [{ inlineData: { data: base64, mimeType } }, { text: "この購入履歴のスクリーンショットから購入商品を抽出してください。" }],
    schema: listSchema,
  });
  return toCandidates(out);
}

/** Text copied from a purchase-history page (Ctrl+A → Ctrl+C) → product candidates. */
export async function extractFromText(text: string): Promise<ImportCandidate[]> {
  const out = await generateJson<Extracted>({
    system: EXTRACT_SYSTEM,
    parts: [{ text: `以下は購入履歴ページからコピーしたテキストです。購入商品を抽出してください。\n\n---\n${text.slice(0, 30_000)}` }],
    schema: listSchema,
  });
  return toCandidates(out);
}

function toCandidates(out: Extracted): ImportCandidate[] {
  return out.items
    .filter((i) => i.title?.trim())
    .slice(0, MAX_ITEMS_PER_IMPORT)
    .map((i) => {
      if (i.url && looksLikeProductUrl(i.url)) return { url: i.url, title: i.title.trim(), price: i.price ?? null, shopHint: i.shop };
      const s = shopSearchUrl(i.shop, i.title.trim());
      return { url: s.url, urlIsSearch: true, title: i.title.trim(), price: i.price ?? null, shopHint: i.shop };
    });
}

/** Links collected by the bookmarklet on a purchase-history page → product candidates. */
export function candidatesFromLinks(links: { href: string; text: string; img?: string | null }[]): ImportCandidate[] {
  const byKey = new Map<string, ImportCandidate>();
  for (const l of links) {
    if (!looksLikeProductUrl(l.href)) continue;
    const key = detectShop(l.href).productKey ?? l.href;
    const prev = byKey.get(key);
    const title = l.text.replace(/\s+/g, " ").trim().slice(0, 200);
    // The same product often appears as an image link and a text link; merge them.
    byKey.set(key, {
      url: l.href,
      title: (prev?.title?.length ?? 0) >= title.length ? prev!.title : title,
      imageUrl: prev?.imageUrl ?? l.img ?? null,
    });
  }
  return [...byKey.values()].slice(0, MAX_ITEMS_PER_IMPORT * 2);
}

const enrichSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          i: { type: Type.INTEGER },
          category: { type: Type.STRING, enum: ["book", "comic", "video", "game", "music", "goods", "other"] },
          tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: "ジャンル・作品シリーズ・作者などの短いタグ（最大4つ）" },
          adult: { type: Type.BOOLEAN, description: "成人向け（R18）商品と思われる場合 true" },
        },
        required: ["i", "category", "tags", "adult"],
      },
    },
  },
  required: ["items"],
};

/** Categorize and tag items in one batched LLM call. R18-shop titles are not sent. */
async function enrich(items: { title: string; shop: string; adultShop: boolean }[]) {
  const visible = items.map((it, i) => ({ i, it })).filter(({ it }) => !it.adultShop);
  const result = new Map<number, { category: Category; tags: string[]; adult: boolean }>();
  if (visible.length) {
    const out = await generateJson<{ items: { i: number; category: Category; tags: string[]; adult: boolean }[] }>({
      model: LITE_MODEL,
      system: "商品リストを分類し、趣味嗜好の分析に役立つ短い日本語タグを付けてください。性的に露骨な語はタグにしないでください。",
      parts: [{ text: JSON.stringify(visible.map(({ i, it }) => ({ i, title: it.title, shop: it.shop }))) }],
      schema: enrichSchema,
    });
    for (const r of out.items) result.set(r.i, { category: r.category, tags: r.tags.slice(0, 4), adult: r.adult });
  }
  return items.map((_, i) => result.get(i) ?? { category: "other" as Category, tags: [], adult: false });
}

async function mapLimit<T, R>(arr: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(arr.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, arr.length) }, async () => {
      while (next < arr.length) {
        const i = next++;
        out[i] = await fn(arr[i]);
      }
    }),
  );
  return out;
}

export interface ImportReport {
  created: number;
  skipped: number;
  flagged: number;
}

/**
 * Import pipeline: fetch product pages → categorize/tag → store as drafts → privacy guard.
 * Nothing is published until the user reviews the drafts.
 */
export async function importCandidates(uid: string, candidates: ImportCandidate[], source: ImportSource, defaultVisibility: Visibility): Promise<ImportReport> {
  const list = candidates.slice(0, MAX_ITEMS_PER_IMPORT);
  const resolved = await mapLimit(list, 6, async (c) => {
    const url = c.urlIsSearch ? c.url : canonicalizeUrl(c.url);
    const info = detectShop(url);
    let { title, imageUrl = null, price = null } = c;
    if (!c.urlIsSearch && (!title || !imageUrl)) {
      try {
        const meta = await fetchProductMeta(url);
        title = title || meta.title || "";
        imageUrl = imageUrl || meta.imageUrl;
        price = price ?? meta.price;
      } catch {
        // keep what we have; shops often block bots
      }
      if (!title) {
        try {
          const meta = await readProductWithGemini(url);
          title = meta.title ?? "";
          price = price ?? meta.price;
        } catch {
          // fall through: guard will ask the user to check it
        }
      }
    }
    const searchShop = c.urlIsSearch ? shopSearchUrl(c.shopHint, c.title).shop : null;
    return { url, info, title: title || url, imageUrl, price, searchShop, urlIsSearch: !!c.urlIsSearch };
  });

  const enriched = await enrich(resolved.map((r) => ({ title: r.title, shop: r.info.label, adultShop: r.info.adult })));

  const drafts: NewItem[] = resolved.map((r, i) => {
    const adult = r.info.adult || enriched[i].adult;
    return {
      url: r.url,
      urlIsSearch: r.urlIsSearch,
      productKey: r.urlIsSearch ? `search:${r.title}` : r.info.productKey,
      shop: r.searchShop ?? r.info.shop,
      shopLabel: r.urlIsSearch ? detectShop(r.url).label : r.info.label,
      title: r.title.slice(0, 200),
      imageUrl: r.imageUrl,
      price: r.price,
      category: r.info.categoryHint ?? enriched[i].category,
      tags: enriched[i].tags,
      // R18 items can be public; viewers decide whether to see them (canSeeAdult).
      isAdult: adult,
      visibility: defaultVisibility,
      source,
    };
  });

  const ids = await createDrafts(uid, drafts);
  const flagged = ids.length ? await runPrivacyGuard(uid, ids) : 0;
  return { created: ids.length, skipped: drafts.length - ids.length, flagged };
}
