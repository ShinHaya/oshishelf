"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getViewer, requireProfile, SESSION_COOKIE } from "@/lib/session";
import { deleteAccount } from "@/lib/data/account";
import { createUser, getUser, getUserByHandle, updateUser } from "@/lib/data/users";
import { deleteItems, getItem, publishItems, setItemProductInfo, setItemsVisibility, updateItem } from "@/lib/data/items";
import { deleteReview, setReaction, setReview } from "@/lib/data/reviews";
import { addWish, consumeQuota, deleteWishesForItems, follow, isFollowing, markAllRead, notify, removeWish, unfollow } from "@/lib/data/social";
import { extractFromScreenshot, extractFromText, importCandidates, MAX_ITEMS_PER_IMPORT, type ImportReport } from "@/lib/ai/agents/importer";
import { readPurchaseHistory, type PageCard } from "@/lib/ai/agents/history-reader";
import { generateBio, refreshTaste } from "@/lib/ai/agents/profiler";
import { analyzeCompatibility, getCachedCompatibility, type Compatibility } from "@/lib/ai/agents/matcher";
import { chatWithTwin, type ChatTurn } from "@/lib/ai/agents/twin";
import { runWatcherFor } from "@/lib/ai/agents/watcher";
import { runPrivacyGuard } from "@/lib/ai/agents/guard";
import { detectShop, isLoginWallTitle, lacksProductInfo, looksLikeProductUrl, publicProductUrl, shopSearchUrl } from "@/lib/shops";
import type { AgentStep } from "@/lib/ai/adk";
import { canSeeAdult, canSeeItem, canWishItem } from "@/lib/access";
import type { AiBio, Item, ReviewReaction, Visibility } from "@/lib/types";

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

async function attempt<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    // redirect() throws a special error that must propagate
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw e;
    console.error(e);
    return { ok: false, error: e instanceof Error ? e.message : "エラーが発生しました" };
  }
}

const visibility = z.enum(["public", "followers", "private"]);

// ---------- profile ----------

export async function createProfileAction(_: unknown, form: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  const res = await attempt(async () => {
    const input = z
      .object({ handle: z.string().trim(), displayName: z.string().trim().min(1, "表示名を入力してください").max(40), isAdult: z.literal("on").optional() })
      .parse(Object.fromEntries(form));
    await createUser(viewer.uid, { handle: input.handle, displayName: input.displayName, isAdult: input.isAdult === "on" });
  });
  if (res.ok) redirect("/import");
  return res;
}

export async function updateSettingsAction(_: unknown, form: FormData): Promise<ActionResult> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    const input = z
      .object({
        displayName: z.string().trim().min(1).max(40),
        bio: z.string().max(400),
        defaultVisibility: visibility,
        declareAdult: z.literal("on").optional(),
        showAdult: z.literal("on").optional(),
        aiUseAdult: z.literal("on").optional(),
        twinEnabled: z.literal("on").optional(),
      })
      .parse(Object.fromEntries(form));
    const isAdult = profile.isAdult || input.declareAdult === "on";
    // Owner consent for AI features to use their R18 items (as genres/tags). Default off.
    const aiUseAdult = isAdult && input.aiUseAdult === "on";
    await updateUser(uid, {
      isAdult,
      aiUseAdult,
      // Withdrawing consent removes the R18-aware bio version immediately.
      ...(!aiUseAdult && profile.aiBio?.adult ? { aiBio: { ...profile.aiBio, adult: null } } : {}),
      ...(!aiUseAdult && profile.aiBioDraft?.adult ? { aiBioDraft: { ...profile.aiBioDraft, adult: null } } : {}),
      displayName: input.displayName,
      bio: input.bio,
      defaultVisibility: input.defaultVisibility,
      // Viewing R18 items requires the 18+ self-declaration and an explicit opt-in (default off).
      showAdult: isAdult && input.showAdult === "on",
      twinEnabled: input.twinEnabled === "on",
    });
    revalidatePath("/", "layout");
  });
}

// ---------- social ----------

export async function toggleFollowAction(targetUid: string): Promise<ActionResult<boolean>> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    if (await isFollowing(uid, targetUid)) {
      await unfollow(uid, targetUid);
      revalidatePath("/", "layout");
      return false;
    }
    if (!(await getUser(targetUid))) throw new Error("ユーザーが見つかりません");
    await follow(uid, targetUid);
    await notify(targetUid, { kind: "follow", title: `${profile.displayName} さんにフォローされました`, body: "棚を見に行ってみましょう", url: `/u/${profile.handle}` });
    revalidatePath("/", "layout");
    return true;
  });
}

export async function toggleWishAction(itemId: string, wished: boolean): Promise<ActionResult<boolean>> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    if (wished) {
      await removeWish(uid, itemId);
      return false;
    }
    const item = await getItem(z.string().min(1).parse(itemId));
    const following = item?.visibility === "followers" ? await isFollowing(uid, item.ownerUid) : false;
    // Same rule as viewing the item: no drafts, restricted, unfinished (members-only link) or unconsented R18 items.
    if (!item || !canWishItem(item, { viewerUid: uid, viewerProfile: profile, following })) throw new Error("商品が見つかりません");
    await addWish(uid, item);
    revalidatePath("/wishlist");
    return true;
  });
}

export async function markNotificationsReadAction() {
  const { uid } = await requireProfile();
  await markAllRead(uid);
  revalidatePath("/", "layout");
}

// ---------- import ----------

export async function importUrlsAction(_: unknown, form: FormData): Promise<ActionResult<ImportReport>> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    const urls = String(form.get("urls") ?? "")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//.test(s))
      .slice(0, 30);
    if (!urls.length) throw new Error("商品URLを入力してください");
    await consumeQuota(uid, "import");
    const report = await importCandidates(uid, urls.map((url) => ({ url, title: "" })), "url", profile.defaultVisibility);
    revalidatePath("/import/review");
    return report;
  });
}

export async function importScreenshotAction(_: unknown, form: FormData): Promise<ActionResult<ImportReport>> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    const files = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0).slice(0, 5);
    if (!files.length) throw new Error("スクリーンショットを選択してください");
    let total: ImportReport = { created: 0, skipped: 0, flagged: 0 };
    for (const file of files) {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("PNG / JPEG / WebP 画像を選んでください");
      if (file.size > 7 * 1024 * 1024) throw new Error("画像は7MBまでです");
      await consumeQuota(uid, "screenshot");
      const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      const candidates = await extractFromScreenshot(b64, file.type);
      const r = await importCandidates(uid, candidates, "screenshot", profile.defaultVisibility);
      total = { created: total.created + r.created, skipped: total.skipped + r.skipped, flagged: total.flagged + r.flagged };
    }
    revalidatePath("/import/review");
    return total;
  });
}

export async function importPasteAction(_: unknown, form: FormData): Promise<ActionResult<ImportReport>> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    const text = String(form.get("text") ?? "").trim();
    if (text.length < 10) throw new Error("購入履歴ページのテキストを貼り付けてください");
    await consumeQuota(uid, "import");
    // Pasted text may contain product URLs; prefer those.
    const urls = [...new Set(text.match(/https?:\/\/[^\s"'<>]+/g) ?? [])].filter(looksLikeProductUrl);
    const adultUrls = urls.filter((u) => detectShop(u).adult);
    // R18 shop text is never sent to the model: use URL rules only, or ask for the bookmarklet.
    if (adultUrls.length === 0 && ADULT_SHOP_TEXT.test(text) && urls.length < 3) {
      throw new Error("成人向けショップ（FANZA・DLsite など）の購入履歴は、作品名をAIに送らないブックマークレットで取り込んでください");
    }
    const candidates =
      adultUrls.length > 0 || urls.length >= 3 ? urls.map((url) => ({ url, title: "" })) : await extractFromText(text);
    const report = await importCandidates(uid, candidates, "paste", profile.defaultVisibility);
    revalidatePath("/import/review");
    return report;
  });
}

const ADULT_SHOP_TEXT = /(FANZA|DLsite|dmm\.co\.jp|ファンザ)/i;

const bulkSchema = z.object({
  page: z.string().max(2000),
  title: z.string().max(300).optional(),
  // Current bookmarklet: links with their surrounding card, section heading and image candidates.
  cards: z
    .array(
      z.object({
        href: z.string().max(2000),
        text: z.string().max(500),
        context: z.string().max(1000),
        section: z.string().max(200),
        imgs: z.array(z.object({ src: z.string().max(2000), alt: z.string().max(300) })).max(6),
        page: z.number().int().min(1).max(20),
      }),
    )
    .max(2000)
    .optional(),
  // Older bookmarklets saved before the card format.
  links: z.array(z.object({ href: z.string().max(2000), text: z.string().max(500), img: z.string().max(2000).nullable().optional() })).max(3000).optional(),
  text: z.string().max(60_000).optional(),
});

/** Payload posted from the bookmarklet's receiver page. */
export async function importBulkAction(payload: z.infer<typeof bulkSchema>): Promise<ActionResult<ImportReport>> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    const data = bulkSchema.parse(payload);
    await consumeQuota(uid, "import");
    const cards: PageCard[] =
      data.cards ?? (data.links ?? []).map((l) => ({ href: l.href, text: l.text, context: "", section: "", imgs: l.img ? [{ src: l.img, alt: "" }] : [], page: 1 }));
    // The reading agent decides which links are purchases; code verifies URLs/images exist on the page.
    const read = await readPurchaseHistory(cards, data.page, data.title ?? "", MAX_ITEMS_PER_IMPORT);
    let candidates = read.products;
    // Full-page-text fallback only for non-R18 shops (R18 titles must not reach the model).
    if (candidates.length === 0 && data.text && !detectShop(data.page).adult && !ADULT_SHOP_TEXT.test(data.title ?? "")) {
      candidates = await extractFromText(data.text);
    }
    if (candidates.length === 0) throw new Error("このページから購入した商品が見つかりませんでした。購入履歴・ライブラリのページで実行してください");
    const report = await importCandidates(uid, candidates, "bulk", profile.defaultVisibility);
    revalidatePath("/import/review");
    return { ...report, detected: read.products.length, excluded: read.excluded, recovered: read.recovered, notes: read.notes };
  });
}

export async function publishDraftsAction(entries: { id: string; visibility: Visibility }[]): Promise<ActionResult<number>> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    const parsed = z.array(z.object({ id: z.string(), visibility })).max(300).parse(entries);
    const n = await publishItems(uid, parsed);
    // Keep the taste vector fresh for matching; failure here must not block publishing.
    refreshTaste(uid).catch((e) => console.error("refreshTaste", e));
    revalidatePath("/", "layout");
    return n;
  });
}

export async function deleteItemsAction(ids: string[]): Promise<ActionResult<number>> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    const deleted = await deleteItems(uid, z.array(z.string()).max(300).parse(ids));
    // Other people's wishes must not keep a copy of a deleted item; their lists also drop it on read.
    await deleteWishesForItems(deleted).catch((e) => console.error("deleteWishesForItems", e));
    revalidatePath("/", "layout");
    return deleted.length;
  });
}

export async function updateItemsVisibilityAction(ids: string[], v: Visibility): Promise<ActionResult<number>> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    const n = await setItemsVisibility(uid, z.array(z.string()).max(500).parse(ids), visibility.parse(v));
    revalidatePath("/", "layout");
    return n;
  });
}

export async function updateItemVisibilityAction(id: string, v: Visibility): Promise<ActionResult> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    await updateItem(uid, id, { visibility: visibility.parse(v) });
    revalidatePath("/", "layout");
  });
}

/**
 * The owner enters the title of an item whose product page could not be read. The link becomes the
 * public product page when the URL carries its id, else the shop's search results for the title —
 * never the members-only page (library / order history) the import found.
 */
export async function fixItemTitleAction(id: string, rawTitle: string): Promise<ActionResult> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    const title = z.string().trim().min(1, "商品名を入力してください").max(200).parse(rawTitle);
    const item = await getItem(z.string().min(1).parse(id));
    if (!item || item.ownerUid !== uid) throw new Error("not found");
    if (!lacksProductInfo(item)) throw new Error("この作品は商品情報を取得済みです");
    const productUrl = item.urlIsSearch ? null : (publicProductUrl(item.url) ?? (!isLoginWallTitle(item.title) && looksLikeProductUrl(item.url) ? item.url : null));
    if (productUrl) {
      const info = detectShop(productUrl);
      await setItemProductInfo(uid, item.id, { title, url: productUrl, urlIsSearch: false, shop: info.shop, shopLabel: info.label, productKey: info.productKey });
    } else {
      const s = shopSearchUrl(item.shop, title);
      await setItemProductInfo(uid, item.id, { title, url: s.url, urlIsSearch: true, shop: s.shop, shopLabel: detectShop(s.url).label, productKey: `search:${title}` });
    }
    await runPrivacyGuard(uid, [item.id]);
    revalidatePath("/", "layout");
  });
}

// ---------- reviews ----------

export async function saveReviewAction(itemId: string, input: { rating: number; text: string }): Promise<ActionResult> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    const data = z
      .object({ rating: z.number().int().min(1, "評価を選んでください").max(5), text: z.string().trim().max(1000, "口コミは1000文字までです") })
      .parse(input);
    await setReview(uid, z.string().min(1).parse(itemId), data);
    revalidatePath("/", "layout");
  });
}

export async function deleteReviewAction(itemId: string): Promise<ActionResult> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    await deleteReview(uid, z.string().min(1).parse(itemId));
    revalidatePath("/", "layout");
  });
}

/** React to another user's review; `null` withdraws the reaction. Same visibility rules as viewing the item. */
export async function reactToReviewAction(
  itemId: string,
  value: ReviewReaction | null,
): Promise<ActionResult<{ helpful: number; unhelpful: number; mine: ReviewReaction | null }>> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    const v = z.enum(["helpful", "unhelpful"]).nullable().parse(value);
    const item = await getItem(z.string().min(1).parse(itemId));
    const following = item ? await isFollowing(uid, item.ownerUid) : false;
    if (!item || !canSeeItem(item, { viewerUid: uid, viewerProfile: profile, following }) || (item.isAdult && !canSeeAdult(profile))) {
      throw new Error("口コミが見つかりません");
    }
    return setReaction(uid, item.id, v);
  });
}

// ---------- AI agents ----------

export async function generateBioAction(): Promise<ActionResult<{ bio: AiBio; steps: AgentStep[]; adultNote: string | null }>> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    await consumeQuota(uid, "bio");
    const r = await generateBio(uid);
    revalidatePath("/settings");
    return r;
  });
}

export async function applyBioAction(input: { text: string; adultText?: string | null }): Promise<ActionResult> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    const draft = profile.aiBioDraft;
    if (!draft) throw new Error("下書きがありません");
    const text = z.string().trim().min(1).max(400).parse(input.text);
    const adult = draft.adult && input.adultText ? { ...draft.adult, text: z.string().trim().min(1).max(400).parse(input.adultText) } : null;
    await updateUser(uid, { aiBio: { ...draft, text, adult }, aiBioDraft: null });
    revalidatePath("/", "layout");
  });
}

export async function analyzeCompatAction(targetUid: string, force = false): Promise<ActionResult<Compatibility>> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    if (targetUid === uid) throw new Error("自分自身とは比較できません");
    const target = await getUser(targetUid);
    if (!target) throw new Error("ユーザーが見つかりません");
    if (!force) {
      const cached = await getCachedCompatibility(profile, target);
      if (cached && Date.now() - cached.generatedAt < 1000 * 60 * 60 * 24) return cached;
    }
    await consumeQuota(uid, "compat");
    return analyzeCompatibility(profile, target, true);
  });
}

export async function twinChatAction(handle: string, history: ChatTurn[], message: string): Promise<ActionResult<{ reply: string; items: Item[]; steps: AgentStep[] }>> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    const owner = await getUserByHandle(handle);
    if (!owner || !owner.twinEnabled) throw new Error("この人の分身は公開されていません");
    const msg = z.string().trim().min(1).max(500).parse(message);
    const hist = z.array(z.object({ role: z.enum(["user", "twin"]), text: z.string().max(2000) })).max(20).parse(history);
    await consumeQuota(uid, "twin");
    return chatWithTwin(owner, profile, hist, msg);
  });
}

/** Lets a user trigger their own watcher patrol on demand (the scheduler runs it daily). */
export async function runWatcherNowAction(): Promise<ActionResult<{ summary: string; steps: AgentStep[] } | null>> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    await consumeQuota(uid, "watcher");
    const r = await runWatcherFor(uid);
    revalidatePath("/", "layout");
    return r;
  });
}

/** Permanently delete the signed-in user's account and data. The handle must be typed to confirm. */
export async function deleteAccountAction(confirmHandle: string): Promise<ActionResult> {
  const { uid, profile } = await requireProfile();
  const res = await attempt(async () => {
    if (confirmHandle.trim().replace(/^@/, "").toLowerCase() !== profile.handle) throw new Error("ハンドルが一致しません");
    await deleteAccount(uid);
    (await cookies()).delete(SESSION_COOKIE);
  });
  if (res.ok) redirect("/?deleted=1");
  return res;
}
