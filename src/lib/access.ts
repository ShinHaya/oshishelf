import type { Item, UserProfile } from "./types";

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

/**
 * Items that may be sent to the LLM for public-facing output (bio, twin chat, matching):
 * published, fully public and non-adult only, so AI output can never leak restricted items.
 */
export function aiSafeItems(items: Item[]): Item[] {
  return items.filter((i) => i.status === "published" && i.visibility === "public" && !i.isAdult);
}
