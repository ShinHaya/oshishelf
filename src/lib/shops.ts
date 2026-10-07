import type { Category } from "./types";

export interface ShopInfo {
  shop: string;
  label: string;
  /** Whether everything sold under this URL is R18 (e.g. FANZA, DLsite maniax). */
  adult: boolean;
  /** Stable product key for de-duplication, if the URL is a recognizable product page. */
  productKey: string | null;
  categoryHint: Category | null;
}

const DLSITE_ADULT_FLOORS = new Set(["maniax", "pro", "girls", "girls-pro", "bl", "bl-pro", "books", "aix"]);

function host(u: URL) {
  return u.hostname.replace(/^www\./, "");
}

const DMM_BOOK_NON_PRODUCT = new Set(["volumes", "tachiyomi", "review", "reviews", "series", "author"]);

/**
 * FANZA / DMM Books product URLs look like /product/{seriesId}/{contentId}/[tachiyomi/].
 * Series lists (/volumes/) and other pages are not products. Note `?cid=` on these pages is a
 * tracking value, not the content id.
 */
function dmmBookParts(u: URL): { series: string; cid: string } | null {
  if (!u.hostname.startsWith("book.")) return null;
  const m = u.pathname.match(/^\/product\/(\d+)\/([a-z0-9_]+)(?:\/|$)/i);
  if (!m || DMM_BOOK_NON_PRODUCT.has(m[2].toLowerCase()) || !/\d/.test(m[2])) return null;
  return { series: m[1], cid: m[2].toLowerCase() };
}

/** New FANZA/DMM video site: /{floor}/content/?id={contentId} (e.g. /av/content/?id=abc00123). */
function dmmVideoId(u: URL): string | null {
  if (!u.hostname.startsWith("video.")) return null;
  return /^\/[a-z]+\/content\/?$/.test(u.pathname) ? (u.searchParams.get("id")?.toLowerCase() ?? null) : null;
}

/** Content id for FANZA/DMM pages: book path segment, new video site id, else a `cid=` in the path. */
function dmmContentId(u: URL): string | null {
  if (u.hostname.startsWith("book.")) return dmmBookParts(u)?.cid ?? null;
  if (u.hostname.startsWith("video.")) return dmmVideoId(u);
  const library = u.pathname.match(/^\/dc\/-\/mylibrary\/detail\/=\/product_id=([a-z0-9_]+)\//i);
  if (library) return library[1].toLowerCase();
  return u.pathname.match(/cid=([a-z0-9_]+)/i)?.[1] ?? u.searchParams.get("cid");
}

/** Identify the shop, R18-ness and product key of a URL. Unknown shops fall back to the hostname. */
export function detectShop(rawUrl: string): ShopInfo {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { shop: "unknown", label: "不明", adult: false, productKey: null, categoryHint: null };
  }
  const h = host(u);
  const path = u.pathname;

  if (h.endsWith("dmm.co.jp")) {
    const cid = dmmContentId(u);
    const categoryHint: Category | null = h.startsWith("video.")
      ? "video"
      : h.startsWith("book.") || path.includes("/comic")
      ? "comic"
      : path.includes("/doujin")
        ? "comic"
        : path.includes("/pcgame") || path.includes("/dlsoft")
          ? "game"
          : path.includes("/digital/video") || path.includes("/mono/dvd") || path.includes("/av/")
            ? "video"
            : null;
    return { shop: "fanza", label: "FANZA", adult: true, productKey: cid ? `fanza:${cid}` : null, categoryHint };
  }
  if (h.endsWith("dmm.com")) {
    const id = dmmContentId(u);
    const categoryHint: Category | null = h.startsWith("book.") ? "comic" : h.startsWith("games.") ? "game" : path.includes("/digital/") ? "video" : null;
    return { shop: "dmm", label: "DMM", adult: false, productKey: id ? `dmm:${id}` : null, categoryHint };
  }
  if (h.endsWith("dlsite.com")) {
    const floor = path.split("/")[1] ?? "";
    const id = path.match(/product_id\/([A-Z]{2}\d+)/i)?.[1] ?? null;
    return {
      shop: "dlsite",
      label: "DLsite",
      adult: DLSITE_ADULT_FLOORS.has(floor),
      productKey: id ? `dlsite:${id.toUpperCase()}` : null,
      categoryHint: floor === "comic" || floor === "books" ? "comic" : floor === "soft" || floor === "pro" ? "game" : null,
    };
  }
  if (/(^|\.)amazon\.(co\.jp|com)$/.test(h) || h === "amzn.asia" || h === "amzn.to") {
    const asin = path.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})/i)?.[1] ?? null;
    return { shop: "amazon", label: "Amazon", adult: false, productKey: asin ? `amazon:${asin.toUpperCase()}` : null, categoryHint: null };
  }
  if (h.endsWith("rakuten.co.jp")) {
    const id = path.match(/\/rb\/(\d+)/)?.[1] ?? (h.startsWith("item.") ? path.replace(/\/$/, "") : null);
    return { shop: "rakuten", label: "楽天", adult: false, productKey: id ? `rakuten:${id}` : null, categoryHint: path.includes("/rb/") ? "book" : null };
  }
  if (h.endsWith("booth.pm")) {
    const id = path.match(/\/items\/(\d+)/)?.[1] ?? null;
    return { shop: "booth", label: "BOOTH", adult: false, productKey: id ? `booth:${id}` : null, categoryHint: null };
  }
  if (h === "melonbooks.co.jp") {
    const id = u.searchParams.get("product_id");
    return { shop: "melonbooks", label: "メロンブックス", adult: false, productKey: id ? `melon:${id}` : null, categoryHint: "comic" };
  }
  if (h.endsWith("toranoana.jp")) {
    const id = path.match(/\/(\d{6,})/)?.[1] ?? null;
    return { shop: "toranoana", label: "とらのあな", adult: path.includes("/joshi/") ? false : path.includes("/tora_r/") || path.includes("/ec/tora_r"), productKey: id ? `tora:${id}` : null, categoryHint: "comic" };
  }
  if (h === "store.steampowered.com") {
    const id = path.match(/\/app\/(\d+)/)?.[1] ?? null;
    return { shop: "steam", label: "Steam", adult: false, productKey: id ? `steam:${id}` : null, categoryHint: "game" };
  }
  if (h.endsWith("bookwalker.jp")) {
    const id = path.match(/\/(de[0-9a-f-]{20,})/)?.[1] ?? null;
    return { shop: "bookwalker", label: "BOOK☆WALKER", adult: false, productKey: id ? `bw:${id}` : null, categoryHint: "comic" };
  }
  return { shop: h, label: h, adult: false, productKey: `url:${u.origin}${path}${u.search}`, categoryHint: null };
}

/** Patterns used to recognize product links on purchase-history pages (bookmarklet import). */
export function looksLikeProductUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const h = host(u);
    const p = u.pathname;
    if (h.endsWith("dmm.co.jp") || h.endsWith("dmm.com")) {
      if (h.startsWith("book.")) return dmmBookParts(u) !== null;
      if (h.startsWith("video.")) return dmmVideoId(u) !== null;
      return /cid=/.test(p) || /\/detail\//.test(p);
    }
    if (h.endsWith("dlsite.com")) return /product_id\//.test(p);
    if (/amazon\.(co\.jp|com)$/.test(h)) return /\/(dp|gp\/product)\/[A-Z0-9]{10}/i.test(p);
    if (h.endsWith("rakuten.co.jp")) return /\/rb\/\d+/.test(p) || h.startsWith("item.");
    if (h.endsWith("booth.pm")) return /\/items\/\d+/.test(p);
    if (h === "store.steampowered.com") return /\/app\/\d+/.test(p);
    if (h.endsWith("bookwalker.jp")) return /\/de[0-9a-f-]{20,}/.test(p);
    if (h === "melonbooks.co.jp") return u.searchParams.has("product_id");
    return false;
  } catch {
    return false;
  }
}

/** Normalize to a canonical product URL (strip tracking params etc.). */
export function canonicalizeUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  const info = detectShop(rawUrl);
  if (info.shop === "amazon" && info.productKey) {
    return `https://www.amazon.co.jp/dp/${info.productKey.split(":")[1]}`;
  }
  // Collapse book sub-pages (e.g. /tachiyomi/?cid=…) onto the product page so they merge with it.
  const book = dmmBookParts(u);
  if (book) return `https://${u.hostname}/product/${book.series}/${book.cid}/`;
  const videoId = dmmVideoId(u);
  if (videoId) return `https://${u.hostname}${u.pathname}?id=${videoId}`;
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|ref|tag|af_id|ch|ch_id|i3_|_encoding|psc|th|qid|sr|keywords|crid|sprefix|dib)/i.test(key)) u.searchParams.delete(key);
  }
  u.hash = "";
  return u.toString();
}

/**
 * Public product page for a members-only URL (library, reader, order page) that still carries the
 * product id, e.g. Kindle's read.amazon.co.jp/?asin=… Returns null when the id cannot be recovered.
 */
export function publicProductUrl(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const h = host(u);
  const library = u.pathname.match(/^\/dc\/-\/mylibrary\/detail\/=\/product_id=([a-z0-9_]+)\//i);
  if ((h === "dmm.co.jp" || h === "dmm.com") && library) {
    return `https://www.${h}/dc/doujin/-/detail/=/cid=${library[1].toLowerCase()}/`;
  }
  if (/(^|\.)amazon\.(co\.jp|com)$/.test(h)) {
    const asin = u.searchParams.get("asin") ?? u.searchParams.get("ASIN") ?? u.pathname.match(/\/(B0[A-Z0-9]{8})(?:\/|$)/i)?.[1];
    if (asin && /^[A-Z0-9]{10}$/i.test(asin)) return `https://www.${h.endsWith("amazon.com") ? "amazon.com" : "amazon.co.jp"}/dp/${asin.toUpperCase()}`;
  }
  return null;
}

/** Title of a sign-in screen (served instead of the product when the URL needs the buyer's login). */
const LOGIN_WALL_TITLE = /^(?:amazon(?:\.co\.jp|\.com)?|楽天(?:会員)?|rakuten|dmm(?:\.com)?|fanza|dlsite|booth|pixiv|steam)?\s*[:：]?\s*(?:サインイン|ログイン|sign[\s-]?in|log[\s-]?in)(?:して(?:ください)?|が必要です|画面|ページ)?(?:\s*[-|｜:：].*)?$/i;

export function isLoginWallTitle(title: string | null | undefined): boolean {
  return !!title && LOGIN_WALL_TITLE.test(title.trim());
}

/**
 * The product page could not be read at import, so the item has no real title (the URL, or a
 * sign-in screen's title) and its link may lead to a members-only page. Such items stay hidden
 * from other people until the owner enters the title.
 */
export function lacksProductInfo(item: { title: string }): boolean {
  return /^https?:\/\//.test(item.title) || isLoginWallTitle(item.title);
}

/** Sign-in pages a shop redirects to when the requested page needs the buyer's login. */
export function isLoginUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return /^(login|signin|accounts?|auth)\./.test(u.hostname) || /\/(ap\/signin|signin|sign-in|sign_in|login|log-in|auth\/login)(\/|$|\.)/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** When only a title is known (e.g. from a screenshot), link to the shop's search results. */
export function shopSearchUrl(shopHint: string | undefined, title: string): { url: string; shop: string } {
  const q = encodeURIComponent(title);
  const s = (shopHint ?? "").toLowerCase();
  if (s.includes("fanza") || s.includes("dmm.co.jp")) return { url: `https://www.dmm.co.jp/search/=/searchstr=${q}/`, shop: "fanza" };
  if (s.includes("dmm")) return { url: `https://www.dmm.com/search/=/searchstr=${q}/`, shop: "dmm" };
  if (s.includes("dlsite")) return { url: `https://www.dlsite.com/home/fsr/=/keyword/${q}/`, shop: "dlsite" };
  if (s.includes("楽天") || s.includes("rakuten")) return { url: `https://books.rakuten.co.jp/search?sitem=${q}`, shop: "rakuten" };
  if (s.includes("booth")) return { url: `https://booth.pm/ja/search/${q}`, shop: "booth" };
  if (s.includes("steam")) return { url: `https://store.steampowered.com/search/?term=${q}`, shop: "steam" };
  return { url: `https://www.amazon.co.jp/s?k=${q}`, shop: "amazon" };
}

/** Add affiliate parameters for outbound clicks, when configured. */
export function withAffiliate(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const h = host(u);
    const amazonTag = process.env.AFFILIATE_AMAZON_TAG;
    const dmmId = process.env.AFFILIATE_DMM_ID;
    if (amazonTag && /amazon\.co\.jp$/.test(h)) {
      u.searchParams.set("tag", amazonTag);
      return u.toString();
    }
    if (dmmId && (h.endsWith("dmm.co.jp") || h.endsWith("dmm.com"))) {
      return `https://al.${h.endsWith("dmm.co.jp") ? "dmm.co.jp" : "dmm.com"}/?lurl=${encodeURIComponent(u.toString())}&af_id=${encodeURIComponent(dmmId)}&ch=link_tool&ch_id=link`;
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}
