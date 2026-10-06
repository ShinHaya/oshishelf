import "server-only";
import { Type, type Schema } from "@google/genai";
import { generateJson } from "../gemini";
import { canonicalizeUrl, detectShop, looksLikeProductUrl } from "../../shops";
import { largeDmmImage } from "../../product-meta";
import type { ImportCandidate } from "../../types";

/** One link on a purchase-history page, as collected by the bookmarklet. */
export interface PageCard {
  href: string;
  text: string;
  context: string;
  section: string;
  imgs: { src: string; alt: string }[];
  page: number;
}

/** Links pointing at the same product URL, merged so the model sees each target once. */
interface LinkGroup {
  i: number;
  url: string;
  /** R18 shop link: its texts are never sent to the model (titles can be explicit). */
  adult: boolean;
  texts: string[];
  context: string;
  section: string;
  imgs: { src: string; alt: string }[];
  page: number;
}

export interface ReadReport {
  products: ImportCandidate[];
  /** Link groups the agent looked at. */
  reviewed: number;
  /** Product-looking groups the agent judged not to be purchases (recommendations, ads, …). */
  excluded: number;
  /** Items added by the second (recall) pass. */
  recovered: number;
  notes: string[];
}

const NON_PRODUCT_PATH = /\/(help|support|faq|contact|logout|signout|sign-out|login|signin|cart|basket|account|settings|privacy|terms|policy|customer-service|gp\/help|gp\/css)(\/|$|\?)/i;

/** Reading rules for any shop. The model decides; code verifies every URL / image it returns. */
const READER_SYSTEM = `あなたは購入履歴SNS「推し棚」の取り込みエージェントです。
ECサイトの「購入履歴」「注文履歴」「ライブラリ」「本棚」ページから集めたリンクの一覧（#番号つき）を読み、ユーザーが実際に購入した商品を漏れなく、正確に抜き出します。

各リンクには次の情報があります:
- url: リンク先 / link: リンクの文字 / card: リンクを囲む商品カードの文字 / section: 近くの見出し / imgs: カード内の画像（[番号] URL (alt)）/ page: 何ページ目か

含めるもの:
- 購入履歴・注文履歴・ライブラリ・本棚に並ぶ、購入済みの商品（書籍、マンガ、動画、ゲーム、音楽、グッズ、デジタル作品など）。ショップの種類は問わない。
- 同じ注文に複数の商品があれば、すべて別々に含める。

除外するもの:
- 「おすすめ」「この商品を買った人は」「関連商品」「ランキング」「広告」「スポンサー」「最近チェックした商品」など、購入していない商品の枠
- ナビゲーション、カテゴリ、ヘルプ、アカウント、カート、検索、ページ送り
- 商品ページ以外への補助リンク：「試し読み」「レビューを書く」「再度購入」「配送状況」「領収書」「シリーズ一覧/単行本一覧」「著者ページ」など
  （ただしそれしか商品へのリンクがない場合は、その商品を1件として含め、最も商品ページらしいURLを使う）

まとめ方:
- 画像リンク・タイトルリンク・ボタンなど、同じ商品を指す複数のリンクは1件にまとめる（alsoLinks に入れる）。
- title はカード内に書かれた正式な商品名。「独占」「NEW」「セール」などのバッジ、価格、日付、ボタン文字は含めない。巻数・版・副題は残す。
- image はその商品の表紙・パッケージ画像の [番号]。アイコン、ロゴ、星評価、出品者画像は選ばない。なければ null。
- price はカードに書かれた購入価格（数値、円）。なければ null。

厳守:
- url / image は与えられた一覧にあるものだけを番号で指す。新しいURLを作らない。
- 氏名・住所・注文番号・カード情報などの個人情報は出力しない。
- 「（成人向けショップ）」と付いたリンクは、作品名・カード文を［作品名］［伏せ字］として伏せてある。URLの形、リンクの役割（再生・試し読み等）、見出しの種類、画像の有無から購入作品かを判断し、title は空文字でよい（推し棚側で補う）。
- notes には、取り込みきれていない可能性があるときだけ短く書く（例:「もっと見る」ボタンが残っている）。ページ送りは推し棚側で自動的にたどっているので、最後のページに「次へ」が残っていない限り書かない。`;

const readSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    products: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          link: { type: Type.INTEGER, description: "代表とするリンクの#番号（商品ページを指すもの）" },
          alsoLinks: { type: Type.ARRAY, items: { type: Type.INTEGER }, description: "同じ商品を指す他のリンクの#番号" },
          title: { type: Type.STRING },
          image: { type: Type.INTEGER, nullable: true, description: "代表リンクまたは alsoLinks のカード内の画像番号" },
          imageLink: { type: Type.INTEGER, nullable: true, description: "image が属するリンクの#番号" },
          price: { type: Type.NUMBER, nullable: true },
        },
        required: ["link", "title"],
      },
    },
    notes: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["products"],
};

type ReadOut = { products: { link: number; alsoLinks?: number[]; title: string; image?: number | null; imageLink?: number | null; price?: number | null }[]; notes?: string[] };

function groupCards(cards: PageCard[], pageUrl: string): LinkGroup[] {
  const pageHost = (() => {
    try {
      return new URL(pageUrl).host;
    } catch {
      return "";
    }
  })();
  // On an R18 shop page (FANZA, DLsite adult floors…) every card may carry explicit titles.
  const pageAdult = (() => {
    try {
      return detectShop(pageUrl).adult;
    } catch {
      return false;
    }
  })();
  const byUrl = new Map<string, LinkGroup>();
  for (const c of cards) {
    let url: string;
    try {
      url = canonicalizeUrl(c.href);
      const u = new URL(url);
      if (NON_PRODUCT_PATH.test(u.pathname)) continue;
      if (u.host === pageHost && u.pathname === new URL(pageUrl).pathname) continue;
    } catch {
      continue;
    }
    if (!c.text && c.imgs.length === 0) continue;
    const key = detectShop(url).productKey ?? url;
    const g = byUrl.get(key);
    if (g) {
      if (c.text && !g.texts.includes(c.text) && g.texts.length < 4) g.texts.push(c.text);
      for (const img of c.imgs) if (g.imgs.length < 4 && !g.imgs.some((x) => x.src === img.src)) g.imgs.push(img);
      if (!g.context && c.context) g.context = c.context;
      if (!g.section && c.section) g.section = c.section;
    } else {
      byUrl.set(key, { i: byUrl.size, url, adult: detectShop(url).adult || pageAdult, texts: c.text ? [c.text] : [], context: c.context, section: c.section, imgs: [...c.imgs], page: c.page });
    }
  }
  return [...byUrl.values()];
}

/** Words that are UI, not titles — safe to show the model even for R18 links. */
const UI_LABEL = /^(\d+巻を)?(試し読み|立ち読み|サンプル|サンプル動画|再生|視聴|今すぐ視聴|ストリーミング|ダウンロード|再ダウンロード|単行本一覧|一覧|詳細|詳しく見る|もっと見る|作品詳細|商品詳細|レビュー|レビューを書く|購入|購入済み|カートに入れる|今すぐ読む|読む|続きを読む|閲覧|シリーズ|閲覧シリーズ|お気に入り|ほしいものリスト|NEW|New|new|次へ|前へ)$/;
const BADGE_PREFIX = /^(独占あり|独占|新着|NEW|期間限定|予約|セール中?|割引|無料|ポイント\d+%還元|単話|単品)\s*/;
const SAFE_SECTION = /(購入|ライブラリ|マイ|履歴|本棚|おすすめ|オススメ|ランキング|人気|新着|視聴|ダウンロード|お気に入り|関連|広告|最近|シリーズ)/;

function cleanTitle(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3 && BADGE_PREFIX.test(t); i++) t = t.replace(BADGE_PREFIX, "");
  return UI_LABEL.test(t) ? "" : t.slice(0, 200);
}

/** Title chosen by code (used for R18 links, whose texts the model never sees). */
function codeTitle(g: LinkGroup): string {
  const options = [...g.imgs.map((im) => im.alt), ...g.texts].map(cleanTitle).filter((t) => t.length >= 2);
  return options.sort((a, b) => b.length - a.length)[0] ?? "";
}

function describe(g: LinkGroup): string {
  if (g.adult) {
    // Structure only: UI labels, URL, heading category and image presence — never titles or card text.
    const labels = g.texts.filter((t) => UI_LABEL.test(t.trim()));
    const titled = g.texts.some((t) => cleanTitle(t)) || g.imgs.some((im) => cleanTitle(im.alt));
    const imgs = g.imgs.map((im, k) => `[${k}] ${im.src.slice(0, 160)}`).join(" ");
    return `#${g.i} url:${g.url.slice(0, 200)} link:${JSON.stringify([...labels, ...(titled ? ["［作品名］"] : [])].join(" / "))} card:${JSON.stringify(g.context ? `［伏せ字 ${g.context.length}文字］` : "")} section:${JSON.stringify(SAFE_SECTION.test(g.section) ? g.section.slice(0, 40) : g.section ? "［見出し］" : "")} page:${g.page} imgs:${imgs || "なし"} （成人向けショップ）`;
  }
  const imgs = g.imgs.map((im, k) => `[${k}] ${im.src.slice(0, 160)}${im.alt ? ` (${im.alt.slice(0, 60)})` : ""}`).join(" ");
  return `#${g.i} url:${g.url.slice(0, 200)} link:${JSON.stringify(g.texts.join(" / ").slice(0, 160))} card:${JSON.stringify(g.context.slice(0, 240))} section:${JSON.stringify(g.section.slice(0, 60))} page:${g.page} imgs:${imgs || "なし"}`;
}

async function readChunk(groups: LinkGroup[], pageTitle: string, pagesLoaded: number, extraInstruction = ""): Promise<ReadOut> {
  // Local debugging aid: print exactly what the model receives (never enabled in production).
  if (process.env.DEBUG_IMPORT_PROMPT === "1" && process.env.NODE_ENV !== "production") console.log("[import-prompt]\n" + groups.map(describe).join("\n"));
  return generateJson<ReadOut>({
    system: READER_SYSTEM,
    parts: [{ text: `ページ: ${pageTitle}（自動で ${pagesLoaded} ページ分を読み込み済み）\n${extraInstruction}\n\n${groups.map(describe).join("\n")}` }],
    schema: readSchema,
    temperature: 0,
  });
}

/** Deterministic reading: known shop product URLs outside recommendation sections. */
function fallbackRead(groups: LinkGroup[]): ReadOut {
  return {
    products: groups
      .filter((g) => looksLikeProductUrl(g.url) && !RECOMMEND_SECTION.test(g.section))
      .map((g) => ({ link: g.i, title: codeTitle(g), image: g.imgs.length ? 0 : null, imageLink: g.i, price: null })),
  };
}

const RECOMMEND_SECTION = /(おすすめ|オススメ|関連|この商品を|ランキング|人気|広告|スポンサー|最近チェック|閲覧履歴|recommend|related|sponsored|ranking|popular|you may)/i;

/**
 * Purchase-history reader: model classifies & extracts, code verifies (URLs/images must exist on the
 * page), then a recall pass re-asks the model about product-looking links it neither took nor
 * clearly excluded.
 */
export async function readPurchaseHistory(cards: PageCard[], pageUrl: string, pageTitle: string, limit: number): Promise<ReadReport> {
  const groups = groupCards(cards, pageUrl).slice(0, 600);
  const pagesLoaded = Math.max(1, ...cards.map((c) => c.page));
  const byIndex = new Map(groups.map((g) => [g.i, g]));
  const notes = new Set<string>();
  const picked = new Map<number, { title: string; image: string | null; price: number | null }>();
  const covered = new Set<number>();

  const accept = (out: ReadOut) => {
    for (const n of out.notes ?? []) if (n) notes.add(n.slice(0, 200));
    for (const p of out.products) {
      const g = byIndex.get(p.link);
      if (!g || picked.has(g.i)) continue; // unknown index → hallucination, drop
      const related = [g, ...(p.alsoLinks ?? []).map((k) => byIndex.get(k)).filter((x): x is LinkGroup => !!x)];
      related.forEach((r) => covered.add(r.i));
      // The image must be one we actually saw on the page.
      const imgOwner = p.imageLink != null ? related.find((r) => r.i === p.imageLink) : g;
      const image = p.image != null ? (imgOwner?.imgs[p.image]?.src ?? null) : null;
      const title = g.adult ? codeTitle(g) || "成人向け作品" : (p.title || codeTitle(g)).trim();
      if (!title) continue;
      picked.set(g.i, { title: title.slice(0, 200), image: largeDmmImage(image ?? g.imgs[0]?.src ?? null), price: p.price ?? null });
    }
  };

  // Pass 1: chunks of ~120 link groups, a few in parallel.
  const chunks: LinkGroup[][] = [];
  for (let i = 0; i < groups.length; i += 120) chunks.push(groups.slice(i, i + 120));
  for (let i = 0; i < chunks.length; i += 3) {
    const outs = await Promise.all(
      chunks.slice(i, i + 3).map((c) =>
        readChunk(c, pageTitle, pagesLoaded).catch((e) => {
          // One failed chunk (e.g. blocked by safety filters) must not sink the whole import.
          console.error("history-reader: chunk failed, using URL rules", e);
          notes.add("一部のリンクはAIで判定できなかったため、ショップのURLの規則で判定しました。");
          return fallbackRead(c);
        }),
      ),
    );
    outs.forEach(accept);
  }

  // Pass 2 (recall check): product-looking links in the same sections as accepted products, or on
  // known shop product URLs, that the model neither picked nor merged. Ask again with that focus.
  const acceptedSections = new Set([...picked.keys()].map((k) => byIndex.get(k)!.section).filter(Boolean));
  const suspects = groups.filter(
    (g) =>
      !covered.has(g.i) &&
      !RECOMMEND_SECTION.test(g.section) &&
      (looksLikeProductUrl(g.url) || (acceptedSections.has(g.section) && g.imgs.length > 0 && g.texts.some((t) => t.length >= 2))),
  );
  let recovered = 0;
  if (suspects.length > 0 && suspects.length <= 80) {
    const before = picked.size;
    // Example titles help the model, but never R18 ones.
    const examples = [...picked.entries()]
      .filter(([k]) => !byIndex.get(k)!.adult)
      .slice(0, 5)
      .map(([, p]) => `「${p.title}」`)
      .join("、");
    const recheck = await readChunk(
        suspects,
        pageTitle,
        pagesLoaded,
      `再確認: 以下は1回目に選ばれなかったが、購入済み商品の可能性があるリンクです。すでに選ばれた商品の例: ${examples || "なし"}。購入済みの商品だけを products に入れ、おすすめ・補助リンク・重複は入れないでください。`,
    ).catch(() => fallbackRead(suspects));
    accept(recheck);
    recovered = picked.size - before;
  }

  const products: ImportCandidate[] = [...picked.entries()].slice(0, limit).map(([i, p]) => ({
    url: byIndex.get(i)!.url,
    title: p.title,
    imageUrl: p.image,
    price: p.price,
  }));
  const productLike = groups.filter((g) => looksLikeProductUrl(g.url) || g.imgs.length > 0).length;
  return { products, reviewed: groups.length, excluded: Math.max(0, productLike - covered.size), recovered, notes: [...notes].slice(0, 3) };
}
