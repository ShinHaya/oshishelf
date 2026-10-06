import "server-only";
import { safeFetchText } from "./safe-fetch";
import { detectShop } from "./shops";

export interface ProductMeta {
  title: string | null;
  imageUrl: string | null;
  price: number | null;
  description: string | null;
  /** Genre labels listed on the product page (FANZA / DMM / DLsite). */
  genres?: string[];
}

/** Genre links on FANZA/DMM (`article=keyword`) and DLsite (`/genre/`) product pages. */
function extractGenres(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']*(?:article=keyword|\/genre\/)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ""));
    if (text && text.length <= 20) out.add(text);
    if (out.size >= 8) break;
  }
  return [...out];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function meta(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decodeEntities(content) : null;
}

function parsePrice(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 && n < 10_000_000 ? Math.round(n) : null;
}

function jsonLdProduct(html: string): Partial<ProductMeta> {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of blocks) {
    try {
      const data = JSON.parse(body.trim());
      const nodes: unknown[] = Array.isArray(data) ? data : data["@graph"] ?? [data];
      for (const node of nodes as Record<string, unknown>[]) {
        const type = String(node["@type"] ?? "");
        if (!/Product|Book|Movie|VideoGame|CreativeWork/i.test(type)) continue;
        const image = Array.isArray(node.image) ? node.image[0] : node.image;
        const offers = (Array.isArray(node.offers) ? node.offers[0] : node.offers) as Record<string, unknown> | undefined;
        return {
          title: typeof node.name === "string" ? decodeEntities(node.name) : null,
          imageUrl: typeof image === "string" ? image : typeof image === "object" && image ? String((image as Record<string, unknown>).url ?? "") || null : null,
          price: parsePrice(offers?.price as string | undefined ?? offers?.lowPrice as string | undefined),
        };
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return {};
}

function cleanTitle(title: string | null, shop: string): string | null {
  if (!title) return null;
  let t = title;
  if (shop === "amazon") t = t.replace(/^Amazon\.co\.jp[:：]\s*/, "").replace(/\s*[:：|]\s*(本|Kindleストア|DVD|ホビー|おもちゃ|ゲーム).*$/, "");
  if (shop === "steam") t = t.replace(/^Steam\s*で\s*\d+%\s*OFF\s*[:：]\s*/i, "").replace(/^Save \d+% on\s+/i, "").replace(/\s+on Steam$/i, "").replace(/^Steam[:：]\s*/, "");
  t = t.replace(/\s*[-|｜]\s*(FANZA|DMM\.com|DLsite|楽天ブックス|BOOTH|Steam).*$/i, "");
  return t.trim() || null;
}

/**
 * Fallback when scraping fails (bot walls, JS-rendered pages): let Gemini read the page with the
 * URL Context tool. The URL was already validated as public by the caller's safeFetch attempt.
 */
export async function readProductWithGemini(url: string): Promise<ProductMeta> {
  const { genai, LITE_MODEL, withRetry } = await import("./ai/gemini");
  const res = await withRetry(() =>
    genai.models.generateContent({
      model: LITE_MODEL,
      contents: `次の商品ページを読み、商品名と税込価格（円、数値のみ）を「商品名 | 価格」の1行で答えてください。価格が不明なら「商品名 | -」、ページが存在しない・読めないなら「NONE」とだけ答えてください。\n${url}`,
      config: { tools: [{ urlContext: {} }], temperature: 0 },
    }),
  );
  const line = (res.text ?? "").trim().split("\n")[0] ?? "";
  if (!line || line.startsWith("NONE")) return { title: null, imageUrl: null, price: null, description: null };
  const [title, price] = line.split("|").map((x) => x.trim());
  return { title: title || null, imageUrl: null, price: parsePrice(price), description: null };
}

/** DMM / FANZA cover images: prefer the large variant (…pl.jpg) over the small thumbnail (…ps.jpg / pt.jpg). */
export function largeDmmImage(url: string | null): string | null {
  if (!url || !/(ebook-assets|pics|doujin-assets)\.dmm\.(co\.jp|com)/.test(url)) return url;
  return url.replace(/p[st]\.(jpg|webp)(\?.*)?$/, "pl.$1");
}

/** Steam exposes prices via its public store API rather than page metadata. */
async function fetchSteamMeta(appId: string): Promise<ProductMeta | null> {
  const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=jp&l=japanese`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = (await res.json())?.[appId];
  if (!data?.success) return null;
  const d = data.data;
  return {
    title: d.name ?? null,
    imageUrl: d.header_image ?? null,
    price: d.is_free ? 0 : d.price_overview?.final ? Math.round(d.price_overview.final / 100) : null,
    description: d.short_description ?? null,
  };
}

/** Scrape title / image / price from a public product page. Returns nulls when the shop blocks bots. */
export async function fetchProductMeta(url: string): Promise<ProductMeta> {
  const info = detectShop(url);
  if (info.shop === "steam" && info.productKey) {
    const steam = await fetchSteamMeta(info.productKey.split(":")[1]).catch(() => null);
    if (steam) return steam;
  }
  // FANZA and DLsite show an age-check interstitial unless these cookies are set.
  const cookie = info.shop === "fanza" ? "age_check_done=1" : info.shop === "dlsite" ? "adultchecked=1" : undefined;
  const res = await safeFetchText(url, { cookie });
  if (res.status >= 400) return { title: null, imageUrl: null, price: null, description: null };
  const html = res.text;
  const ld = jsonLdProduct(html);
  let title = ld.title ?? meta(html, "og:title") ?? meta(html, "twitter:title") ?? (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ? decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)![1]) : null);
  let imageUrl = ld.imageUrl ?? meta(html, "og:image") ?? meta(html, "twitter:image");
  let price = ld.price ?? parsePrice(meta(html, "product:price:amount") ?? meta(html, "og:price:amount"));

  if (info.shop === "amazon") {
    const pt = html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/)?.[1];
    if (pt) title = decodeEntities(pt);
    const img = html.match(/data-old-hires="([^"]+)"/)?.[1] ?? html.match(/"hiRes":"([^"]+)"/)?.[1];
    if (img) imageUrl = img;
    price ??= parsePrice(html.match(/class="a-price-whole">([\d,]+)/)?.[1]);
    if (/captcha|ロボットではありません/i.test(html) && !pt) title = null;
  }
  if (imageUrl?.startsWith("//")) imageUrl = `https:${imageUrl}`;
  imageUrl = largeDmmImage(imageUrl);
  if (imageUrl && !/^https?:\/\//.test(imageUrl)) imageUrl = null;

  return { title: cleanTitle(title, info.shop), imageUrl, price, description: meta(html, "og:description"), genres: extractGenres(html) };
}
