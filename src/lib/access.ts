import { CATEGORY_LABELS, type Item, type UserProfile } from "./types";

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
  if (item.visibility === "private") return false;
  if (item.visibility === "followers" && !ctx.following) return false;
  return true;
}

/** R18 items stay hidden unless the viewer declared 18+ and opted in. */
export function canSeeAdult(viewer: UserProfile | null): boolean {
  return !!viewer?.isAdult && !!viewer.showAdult;
}

/** R18 items are shown to the model without title, image or URL: only shop, category and genre tags. */
export function redactAdult(item: Item): Item {
  return { ...item, title: `成人向け作品（${item.shopLabel}・${CATEGORY_LABELS[item.category]}）`, imageUrl: null, url: "", note: "", review: null };
}

/**
 * Items an AI feature may read for public-facing output (bio, twin chat, matching): published and
 * fully public only, so AI output can never leak restricted items. R18 items are included only when
 * `includeAdult` is set, and always redacted to genres/tags.
 */
export function aiItems(items: Item[], includeAdult: boolean): Item[] {
  return items
    .filter((i) => i.status === "published" && i.visibility === "public" && (!i.isAdult || includeAdult))
    .map((i) => (i.isAdult ? redactAdult(i) : i));
}

export function aiSafeItems(items: Item[]): Item[] {
  return aiItems(items, false);
}

/** The owner's R18 items may inform AI output for this viewer only if both sides opted in. */
export function adultAiAllowed(owner: UserProfile, viewer: UserProfile | null): boolean {
  return owner.isAdult && owner.aiUseAdult && canSeeAdult(viewer);
}
