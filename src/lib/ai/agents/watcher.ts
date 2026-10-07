import "server-only";
import { FunctionTool, LlmAgent } from "@google/adk";
import { z } from "zod";
import { adkModel, runAgent } from "../adk";
import { genai, MODEL } from "../gemini";
import { db } from "../../firebase-admin";
import { fetchProductMeta } from "../../product-meta";
import { listNotifications, listVisibleWishes, notify, updateWish } from "../../data/social";
import { getUser } from "../../data/users";
import { shopSearchUrl } from "../../shops";
import type { UserProfile } from "../../types";

// Separate budgets so new-release news can never crowd out a verified price drop.
const MAX_PRICE_NOTIFICATIONS = 3;
const MAX_RELEASE_NOTIFICATIONS = 2;
const MAX_SEARCHES_PER_RUN = 2;

/** Grounded Google Search for recent releases; returns plain titles (links are built as shop searches). */
async function searchNewReleases(keyword: string) {
  const res = await genai.models.generateContent({
    model: MODEL,
    contents: `「${keyword}」に関連する、直近1か月以内に発売・発売決定した書籍・マンガ・ゲーム・映像作品を最大3件調べてください。
各行に「タイトル | 発売日 | 一言説明」の形式で書き、該当がなければ「なし」とだけ書いてください。成人向け作品は除外してください。`,
    config: { tools: [{ googleSearch: {} }], temperature: 0.1 },
  });
  const text = res.text ?? "";
  const releases = text
    .split("\n")
    .map((l) => l.replace(/^[-*・\d.\s]+/, "").split("|").map((s) => s.trim()))
    .filter((p) => p.length >= 2 && p[0] && p[0] !== "なし")
    .slice(0, 3)
    .map(([title, date, note]) => ({ title, date, note: note ?? "" }));
  return { keyword, releases };
}

const DROP_THRESHOLD = 0.05;

interface PatrolStats {
  checked: number;
  priceSent: number;
  releaseSent: number;
}

function buildAgent(user: UserProfile, stats: PatrolStats) {
  const { uid, tasteTags } = user;
  // Only wishes for items the user may still see: hidden or deleted items are never fetched or announced.
  const wishes = () => listVisibleWishes(uid, user);
  let searches = 0;
  // Price drops verified by code during this run. The model may only notify about these.
  const verifiedDrops = new Map<string, { previous: number; current: number }>();
  return new LlmAgent({
    name: "watcher_agent",
    // Flash rather than Flash-Lite: this agent chains many tool calls and Lite occasionally emits malformed calls.
    model: adkModel(),
    instruction: `あなたは購入履歴SNS「推し棚」のウォッチャーエージェントです。ユーザーの代わりに定期巡回し、本当に役立つ情報だけを通知します。

手順:
1. まず list_watched_wishes で「ほしい」リストを取得し、各商品を check_price で確認する（新作検索より先に行う）
2. check_price の結果で priceDropped が true の商品だけ、notify_user（kind=price_drop, itemId 指定）で通知する。priceDropped が false の商品は絶対に値下がりとして通知しない
3. ユーザーの好きなタグ（${tasteTags.slice(0, 6).join("、") || "なし"}）から最大${MAX_SEARCHES_PER_RUN}個選び search_new_releases で新作を探し、見つかったら notify_user で知らせる
4. 通知前に get_recent_notifications で同じ内容を最近通知していないか確認し、重複は送らない

通知の上限は1回の巡回で値下がり${MAX_PRICE_NOTIFICATIONS}件・新作${MAX_RELEASE_NOTIFICATIONS}件。何もなければ通知しなくてよい。
notify_user がエラーを返した通知は送られていない。
通知文も最後の要約も必ず日本語で書く。最後に実施内容を1〜2文で要約してください。`,
    tools: [
      new FunctionTool({
        name: "list_watched_wishes",
        description: "ウォッチ中の「ほしい」商品の一覧（前回価格つき）",
        execute: async () => ({
          wishes: (await wishes()).filter((w) => w.watch).slice(0, 15).map((w) => ({ itemId: w.itemId, title: w.title, shop: w.shopLabel, lastPrice: w.lastPrice })),
        }),
      }),
      new FunctionTool({
        name: "check_price",
        description: "ほしい商品の商品ページを確認し、現在価格を取得して記録する",
        parameters: z.object({ itemId: z.string() }),
        execute: async ({ itemId }) => {
          const wish = (await wishes()).find((w) => w.itemId === itemId);
          if (!wish) return { error: "ウォッチ中の商品ではありません" };
          try {
            const meta = await fetchProductMeta(wish.url);
            stats.checked++;
            await updateWish(uid, itemId, { lastCheckedAt: Date.now(), ...(meta.price ? { lastPrice: meta.price } : {}) });
            // The drop decision is made in code, not by the model.
            const priceDropped = !!(meta.price && wish.lastPrice && meta.price <= wish.lastPrice * (1 - DROP_THRESHOLD));
            if (priceDropped) verifiedDrops.set(itemId, { previous: wish.lastPrice!, current: meta.price! });
            return { itemId, title: wish.title, previousPrice: wish.lastPrice, currentPrice: meta.price, priceDropped };
          } catch {
            return { itemId, error: "商品ページを取得できませんでした" };
          }
        },
      }),
      new FunctionTool({
        name: "search_new_releases",
        description: "キーワード（作家・シリーズ・ジャンル）に関する最近の新作をGoogle検索で調べる",
        parameters: z.object({ keyword: z.string() }),
        execute: async ({ keyword }) => {
          if (searches >= MAX_SEARCHES_PER_RUN) return { error: "今回の巡回の検索上限に達しました" };
          searches++;
          return searchNewReleases(keyword);
        },
      }),
      new FunctionTool({
        name: "get_recent_notifications",
        description: "最近ユーザーに送った通知のタイトル一覧（重複防止用）",
        execute: async () => ({ titles: (await listNotifications(uid, 30)).map((n) => n.title) }),
      }),
      new FunctionTool({
        name: "notify_user",
        description: "ユーザーに通知を送る。値下がりは itemId を、新作は releaseTitle を指定する",
        parameters: z.object({
          kind: z.enum(["price_drop", "new_release"]),
          title: z.string().max(60),
          body: z.string().max(200),
          itemId: z.string().optional(),
          releaseTitle: z.string().optional(),
        }),
        execute: async ({ kind, title, body: rawBody, itemId, releaseTitle }) => {
          let body = rawBody;
          if (kind === "price_drop" && stats.priceSent >= MAX_PRICE_NOTIFICATIONS) return { error: "今回の値下がり通知の上限に達しました" };
          if (kind === "new_release" && stats.releaseSent >= MAX_RELEASE_NOTIFICATIONS) return { error: "今回の新作通知の上限に達しました。これ以上は送れません" };
          if (kind === "price_drop") {
            const drop = itemId ? verifiedDrops.get(itemId) : undefined;
            if (!drop) return { error: "この商品の値下がりは check_price で確認されていません。通知できません" };
            body = `${body}（¥${drop.previous.toLocaleString()} → ¥${drop.current.toLocaleString()}）`;
          }
          let url: string | null = null;
          if (itemId) url = (await wishes()).find((w) => w.itemId === itemId)?.url ?? null;
          else if (releaseTitle) url = shopSearchUrl(undefined, releaseTitle).url;
          await notify(uid, { kind, title, body, url });
          if (kind === "price_drop") stats.priceSent++;
          else stats.releaseSent++;
          return { ok: true };
        },
      }),
    ],
  });
}

/** One autonomous patrol for a user; every run is recorded in `agentRuns` for auditability. */
export async function runWatcherFor(uid: string) {
  const user = await getUser(uid);
  if (!user) return null;
  const started = Date.now();
  try {
    const stats: PatrolStats = { checked: 0, priceSent: 0, releaseSent: 0 };
    const { text, steps } = await runAgent(buildAgent(user, stats), uid, "巡回を開始してください。");
    // The summary shown to users comes from what the tools actually did, not from the model's claims.
    const summary = `ほしい物 ${stats.checked} 件の価格を確認し、値下がり ${stats.priceSent} 件・新作 ${stats.releaseSent} 件を通知しました。`;
    await db.collection("agentRuns").add({ agent: "watcher", uid, ok: true, summary, agentReply: text.slice(0, 500), stats, steps, startedAt: started, finishedAt: Date.now() });
    return { summary, steps };
  } catch (e) {
    await db.collection("agentRuns").add({ agent: "watcher", uid, ok: false, error: String(e).slice(0, 500), startedAt: started, finishedAt: Date.now() });
    throw e;
  }
}
