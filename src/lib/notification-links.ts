import { detectShop, isKnownShopUrl, looksLikeProductUrl } from "./shops";
import type { Notification, ProductLink } from "./types";

/** Include legacy notifications' primary product URL; never turn search pages into product links. */
export function notificationProductLinks(notification: Notification): ProductLink[] {
  if (notification.kind !== "price_drop" && notification.kind !== "new_release") return [];
  const urls = [notification.url, ...(notification.productLinks ?? []).map((link) => link.url)];
  const shops = new Set<string>();
  const links: ProductLink[] = [];
  for (const url of urls) {
    if (!url || !isKnownShopUrl(url) || !looksLikeProductUrl(url)) continue;
    const { shop, label } = detectShop(url);
    if (shops.has(shop)) continue;
    shops.add(shop);
    links.push({ shop, label, url });
  }
  return links;
}
