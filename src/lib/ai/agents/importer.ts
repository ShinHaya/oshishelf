import "server-only";
import { Type, type Schema } from "@google/genai";
import { generateJson, LITE_MODEL } from "../gemini";
import { canonicalizeUrl, detectShop, looksLikeProductUrl, shopSearchUrl } from "../../shops";
import { fetchProductMeta, readProductWithGemini } from "../../product-meta";
import { createDrafts, type NewItem } from "../../data/items";
import type { Category, ImportCandidate, ImportSource, Visibility } from "../../types";
import { runPrivacyGuard } from "./guard";

export const MAX_ITEMS_PER_IMPORT = 150;

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

const EXTRACT_SYSTEM = `あなたは購入履歴SNS「推し棚」の取り込みエージェントです。ECサイトの購入履歴・注文履歴・ライブラリ・本棚から、ユーザーが購入した商品を漏れなく正確に列挙します。
- 含める: 購入済みとして並んでいる商品すべて（同じ注文の複数商品も別々に）。ショップの種類は問わない。
- 除外: 「おすすめ」「この商品を買った人は」「関連商品」「ランキング」「広告」「最近チェックした商品」の枠、ナビゲーション、ボタン（試し読み・再度購入・レビューを書く・配送状況・領収書）。
- title: 画面に書かれた正式な商品名。「独占」「NEW」「セール」などのバッジ、価格、日付は含めない。巻数・版・副題は残す。
- 商品名の中に贈り先・宛名・氏名・メッセージが含まれている場合は、その部分を取り除く。
- 注文番号・配送先・氏名・住所・カード情報などの個人情報は絶対に出力しない。
- 同じ商品は1回だけ出力する。`;

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
  /** Bulk import only: what the reading agent did. */
  detected?: number;
  excluded?: number;
  recovered?: number;
  notes?: string[];
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
    let genres: string[] = [];
    // Always read the product page: its official title / cover beat link text scraped from a
    // library page (which may be a label or carry badges), and R18 genres come from it too.
    if (!c.urlIsSearch) {
      try {
        const meta = await fetchProductMeta(url);
        // Official page title wins, unless it is generic (site name only) — then keep the card's title.
        const generic = !meta.title || meta.title.length < 2 || /^(amazon|amazon\.co\.jp|fanza|dmm|dlsite|楽天|rakuten|booth|steam)( |$)/i.test(meta.title);
        title = (!generic && meta.title) || title || "";
        imageUrl = meta.imageUrl || imageUrl;
        price = price ?? meta.price;
        genres = meta.genres ?? [];
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
    return { url, info, title: title || url, imageUrl, price, genres, searchShop, urlIsSearch: !!c.urlIsSearch };
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
      tags: r.info.adult ? r.genres.slice(0, 6) : enriched[i].tags,
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
