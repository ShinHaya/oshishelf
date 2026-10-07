import { lacksProductInfo } from "./shops";
import { CATEGORY_LABELS, type Item, type UserProfile, type Wish } from "./types";

export interface ViewContext {
  viewerUid: string | null;
  viewerProfile: UserProfile | null;
  /** Whether the viewer follows the item owner. */
  following: boolean;
}

/** Visibility rule for a published item. */
export function canSeeItem(item: Item, ctx: ViewContext): boolean {
  if (item.ownerUid === ctx.viewerUid) return true;
  if (item.status !== "published") return false;
  // No real title, and the link may be a members-only page: hidden until the owner fixes it.
  if (lacksProductInfo(item)) return false;
  if (item.visibility === "private") return false;
  if (item.visibility === "followers" && !ctx.following) return false;
  return true;
}

/** R18 items stay hidden unless the viewer declared 18+ and opted in. */
export function canSeeAdult(viewer: UserProfile | null): boolean {
  return !!viewer?.isAdult && !!viewer.showAdult;
}

/** Whether a viewer may wish for / keep seeing an item: published, visible to them, and R18 only with their opt-in. */
export function canWishItem(item: Item, ctx: ViewContext): boolean {
  return item.status === "published" && canSeeItem(item, ctx) && (!item.isAdult || item.ownerUid === ctx.viewerUid || canSeeAdult(ctx.viewerProfile));
}

/** A wish refreshed from its live item. `isAdult` is the item's current flag and is not stored. */
export type VisibleWish = Wish & { isAdult: boolean };

/**
 * Re-check saved wishes against the live items: a wish is shown (with the item's current title, link
 * and image) only while the viewer may still see the item. Wishes whose item was deleted or withdrawn
 * from this viewer (unpublished, private, followers-only after unfollowing…) are returned in `gone` for
 * deletion. Only R18 items hidden by the viewer's own display setting are kept without being shown.
 */
export function resolveWishes(
  wishes: Wish[],
  items: Map<string, Item>,
  viewer: { uid: string; profile: UserProfile | null },
  followingOwners: Set<string>,
): { visible: VisibleWish[]; gone: string[] } {
  const visible: VisibleWish[] = [];
  const gone: string[] = [];
  for (const w of wishes) {
    const item = items.get(w.itemId);
    if (!item) {
      gone.push(w.itemId);
      continue;
    }
    const ctx = { viewerUid: viewer.uid, viewerProfile: viewer.profile, following: followingOwners.has(item.ownerUid) };
    if (item.status !== "published" || !canSeeItem(item, ctx)) {
      gone.push(w.itemId);
      continue;
    }
    if (!canWishItem(item, ctx)) continue;
    visible.push({
      ...w,
      ownerUid: item.ownerUid,
      url: item.url,
      title: item.title,
      imageUrl: item.imageUrl,
      shop: item.shop,
      shopLabel: item.shopLabel,
      // A price recorded for another link must not be compared with the new page's price.
      lastPrice: item.url === w.url ? w.lastPrice : null,
      watch: w.watch && !item.urlIsSearch,
      isAdult: item.isAdult,
    });
  }
  return { visible, gone };
}

/** R18 items are shown to the model without title, image or URL: only shop, category and genre tags. */
export function redactAdult(item: Item): Item {
  return { ...item, title: `成人向け作品（${item.shopLabel}・${CATEGORY_LABELS[item.category]}）`, imageUrl: null, url: "", note: "", review: null, shelfCategory: null };
}

/**
 * Items an AI feature may read for public-facing output (bio, twin chat, matching): published and
 * fully public only, so AI output can never leak restricted items. R18 items are included only when
 * `includeAdult` is set, and always redacted to genres/tags.
 */
export function aiItems(items: Item[], includeAdult: boolean): Item[] {
  return items
    .filter((i) => i.status === "published" && i.visibility === "public" && !lacksProductInfo(i) && (!i.isAdult || includeAdult))
    .map((i) => (i.isAdult ? redactAdult(i) : i.shelfCategory ? { ...i, shelfCategory: null } : i));
}

export function aiSafeItems(items: Item[]): Item[] {
  return aiItems(items, false);
}

/** The owner's R18 items may inform AI output for this viewer only if both sides opted in. */
export function adultAiAllowed(owner: UserProfile, viewer: UserProfile | null): boolean {
  return owner.isAdult && owner.aiUseAdult && canSeeAdult(viewer);
}
