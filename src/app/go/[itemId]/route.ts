import { NextResponse } from "next/server";
import { getViewer } from "@/lib/session";
import { getItem, incrementClick } from "@/lib/data/items";
import { isFollowing } from "@/lib/data/social";
import { canSeeAdult, canSeeItem } from "@/lib/access";
import { isKnownShopUrl, isProductUrl, lacksProductInfo, withAffiliate } from "@/lib/shops";

/** Outbound link to the shop: checks visibility, counts the click, and applies affiliate params. */
export async function GET(req: Request, ctx: RouteContext<"/go/[itemId]">) {
  const { itemId } = await ctx.params;
  const [item, viewer] = await Promise.all([getItem(itemId), getViewer()]);
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  const me = viewer?.profile ?? null;
  const following = me ? await isFollowing(me.uid, item.ownerUid) : false;
  const isOwner = me?.uid === item.ownerUid;
  if (!canSeeItem(item, { viewerUid: me?.uid ?? null, viewerProfile: me, following }) || (item.isAdult && !isOwner && !canSeeAdult(me))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // The stored link may be a members-only page (library / order history); others never see such
  // items (canSeeItem), and the owner is sent to enter the title instead.
  if (lacksProductInfo(item)) return NextResponse.redirect(new URL(item.status === "draft" ? "/import/review" : "/shelf", req.url), 302);
  if (!isProductUrl(item.url)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!isKnownShopUrl(item.url)) {
    const destination = new URL(item.url);
    // Unknown shops remain usable, but require an explicit click on the actual destination.
    const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    return new NextResponse(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>外部サイトへの移動</title>
<style>body{font-family:system-ui,sans-serif;background:#faf8f4;color:#292524;margin:0;padding:24px}main{max-width:640px;margin:10vh auto;background:white;border:1px solid #e7e5e4;border-radius:16px;padding:28px}h1{font-size:24px}p{line-height:1.8;overflow-wrap:anywhere}a{color:#a34b28}</style>
</head><body><main><h1>外部サイトへ移動します</h1>
<p>このショップは推し棚の確認対象に含まれていません。移動先を確認してください。</p>
<p><strong>${escape(destination.hostname)}</strong></p>
<p><a href="${escape(destination.href)}" rel="noreferrer nofollow">${escape(destination.href)}</a></p>
<a href="/">推し棚へ戻る</a></main></body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!isOwner) incrementClick(item.id).catch(() => {});
  return NextResponse.redirect(withAffiliate(item.url), 302);
}
