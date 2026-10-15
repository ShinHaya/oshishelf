import "server-only";
import { safeFetchText } from "./safe-fetch";
import { fetchProductMeta } from "./product-meta";
import { canonicalizeUrl, detectShop, isKnownShopUrl, looksLikeProductUrl, shopSearchUrl } from "./shops";
import type { Category, ProductLink } from "./types";

const ADULT_SHOPS = new Set(["fanza", "dlsite"]);
const SUPPORTED = new Set(["amazon", "rakuten", "steam", "dmm", "fanza", "dlsite", "booth", "melonbooks", "toranoana", "bookwalker"]);

/** Keep mainstream and adult/doujin catalogues separate before making any requests. */
export function recommendationShops(used: string[], sourceShop: string, isAdult: boolean, category: Category = "other"): string[] {
  const specialist = ADULT_SHOPS.has(sourceShop);
  return [...new Set(used)].filter((shop) => SUPPORTED.has(shop) &&
    (isAdult ? ADULT_SHOPS.has(shop) : ADULT_SHOPS.has(shop) === specialist) &&
    (shop !== "steam" || category === "game" || category === "other") &&
    (shop !== "bookwalker" || category === "book" || category === "comic" || category === "other"));
}

function searchUrl(shop: string, title: string): string {
  const q = encodeURIComponent(title);
  if (shop === "melonbooks") return `https://www.melonbooks.co.jp/search/search.php?name=${q}`;
  if (shop === "toranoana") return `https://ecs.toranoana.jp/tora/ec/app/catalog/list?searchWord=${q}`;
  if (shop === "bookwalker") return `https://bookwalker.jp/search/?q=${q}`;
  return shopSearchUrl(shop, title).url;
}

const normalized = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

/** No model sees the title here. Only links found on a shop page and verified against product metadata survive. */
export async function findRecommendationProducts(title: string, shops: string[], isAdult: boolean): Promise<ProductLink[]> {
  const links: ProductLink[] = [];
  for (const shop of shops) {
    try {
      const url = shop === "dlsite" && isAdult
        ? `https://www.dlsite.com/maniax/fsr/=/keyword/${encodeURIComponent(title)}/`
        : searchUrl(shop, title);
      const cookie = shop === "fanza" ? "age_check_done=1" : shop === "dlsite" ? "adultchecked=1" : undefined;
      const page = await safeFetchText(url, { cookie });
      if (page.status >= 400 || detectShop(page.url).shop !== shop) continue;
      const candidates = new Set<string>();
      for (const match of page.text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
        try {
          const url = new URL(match[1].replace(/&amp;/g, "&"), page.url).toString();
          const info = detectShop(url);
          if (isKnownShopUrl(url) && looksLikeProductUrl(url) && info.productKey && info.shop === shop && (isAdult || !info.adult)) candidates.add(canonicalizeUrl(url));
        } catch { /* Ignore malformed links. */ }
        if (candidates.size >= 3) break;
      }
      for (const url of candidates) {
        const meta = await fetchProductMeta(url);
        // Exact normalized title avoids editions, sequels and unrelated search hits.
        if (!meta.loginWall && meta.title && normalized(meta.title) === normalized(title)) {
          links.push({ shop, label: detectShop(url).label, url });
          break;
        }
      }
    } catch { /* Unavailable stores must not prevent other stores from being checked. */ }
  }
  return links;
}
