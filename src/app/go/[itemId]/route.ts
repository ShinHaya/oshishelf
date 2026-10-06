import { NextResponse } from "next/server";
import { getViewer } from "@/lib/session";
import { getItem, incrementClick } from "@/lib/data/items";
import { isFollowing } from "@/lib/data/social";
import { canSeeAdult, canSeeItem } from "@/lib/access";
import { withAffiliate } from "@/lib/shops";

/** Outbound link to the shop: checks visibility, counts the click, and applies affiliate params. */
export async function GET(_req: Request, ctx: RouteContext<"/go/[itemId]">) {
  const { itemId } = await ctx.params;
  const [item, viewer] = await Promise.all([getItem(itemId), getViewer()]);
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  const me = viewer?.profile ?? null;
  const following = me ? await isFollowing(me.uid, item.ownerUid) : false;
  const isOwner = me?.uid === item.ownerUid;
  if (!canSeeItem(item, { viewerUid: me?.uid ?? null, viewerProfile: me, following }) || (item.isAdult && !isOwner && !canSeeAdult(me))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!isOwner) incrementClick(item.id).catch(() => {});
  return NextResponse.redirect(withAffiliate(item.url), 302);
}
