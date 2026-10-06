"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getViewer, requireProfile } from "@/lib/session";
import { createUser, getUser, getUserByHandle, updateUser } from "@/lib/data/users";
import { deleteItems, getItem, publishItems, updateItem } from "@/lib/data/items";
import { addWish, consumeQuota, follow, isFollowing, markAllRead, notify, removeWish, unfollow } from "@/lib/data/social";
import { candidatesFromLinks, extractFromScreenshot, extractFromText, importCandidates, type ImportReport } from "@/lib/ai/agents/importer";
import { generateBio, refreshTaste } from "@/lib/ai/agents/profiler";
import { analyzeCompatibility, getCachedCompatibility, type Compatibility } from "@/lib/ai/agents/matcher";
import { chatWithTwin, type ChatTurn } from "@/lib/ai/agents/twin";
import { runWatcherFor } from "@/lib/ai/agents/watcher";
import { looksLikeProductUrl } from "@/lib/shops";
import type { AgentStep } from "@/lib/ai/adk";
import type { AiBio, Item, Visibility } from "@/lib/types";

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
        showAdult: z.literal("on").optional(),
        twinEnabled: z.literal("on").optional(),
      })
      .parse(Object.fromEntries(form));
    await updateUser(uid, {
      displayName: input.displayName,
      bio: input.bio,
      defaultVisibility: input.defaultVisibility,
      // R18 display requires the 18+ self-declaration made at sign-up.
      showAdult: profile.isAdult && input.showAdult === "on",
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
  const { uid } = await requireProfile();
  return attempt(async () => {
    if (wished) {
      await removeWish(uid, itemId);
      return false;
    }
    const item = await getItem(itemId);
    if (!item || item.status !== "published" || item.visibility === "private") throw new Error("商品が見つかりません");
    if (item.visibility === "followers" && item.ownerUid !== uid && !(await isFollowing(uid, item.ownerUid))) throw new Error("商品が見つかりません");
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
    const candidates = urls.length >= 3 ? urls.map((url) => ({ url, title: "" })) : await extractFromText(text);
    const report = await importCandidates(uid, candidates, "paste", profile.defaultVisibility);
    revalidatePath("/import/review");
    return report;
  });
}

const bulkSchema = z.object({
  page: z.string().max(2000),
  links: z.array(z.object({ href: z.string().max(2000), text: z.string().max(500), img: z.string().max(2000).nullable().optional() })).max(3000),
  text: z.string().max(60_000).optional(),
});

/** Payload posted from the bookmarklet's receiver page. */
export async function importBulkAction(payload: z.infer<typeof bulkSchema>): Promise<ActionResult<ImportReport>> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    const data = bulkSchema.parse(payload);
    await consumeQuota(uid, "import");
    let candidates = candidatesFromLinks(data.links);
    if (candidates.length === 0 && data.text) candidates = await extractFromText(data.text);
    if (candidates.length === 0) throw new Error("このページから商品が見つかりませんでした");
    const report = await importCandidates(uid, candidates, "bulk", profile.defaultVisibility);
    revalidatePath("/import/review");
    return report;
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
    const n = await deleteItems(uid, z.array(z.string()).max(300).parse(ids));
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

// ---------- AI agents ----------

export async function generateBioAction(): Promise<ActionResult<{ bio: AiBio; steps: AgentStep[] }>> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    await consumeQuota(uid, "bio");
    const r = await generateBio(uid);
    revalidatePath("/settings");
    return r;
  });
}

export async function applyBioAction(text: string): Promise<ActionResult> {
  const { uid, profile } = await requireProfile();
  return attempt(async () => {
    if (!profile.aiBioDraft) throw new Error("下書きがありません");
    await updateUser(uid, { aiBio: { ...profile.aiBioDraft, text: z.string().trim().min(1).max(400).parse(text) }, aiBioDraft: null });
    revalidatePath("/", "layout");
  });
}

export async function analyzeCompatAction(targetUid: string, force = false): Promise<ActionResult<Compatibility>> {
  const { uid } = await requireProfile();
  return attempt(async () => {
    if (targetUid === uid) throw new Error("自分自身とは比較できません");
    if (!force) {
      const cached = await getCachedCompatibility(uid, targetUid);
      if (cached && Date.now() - cached.generatedAt < 1000 * 60 * 60 * 24) return cached;
    }
    await consumeQuota(uid, "compat");
    return analyzeCompatibility(uid, targetUid, true);
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
    return chatWithTwin(owner, uid, profile.displayName, hist, msg);
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
