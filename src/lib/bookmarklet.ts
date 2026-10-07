import type { PageCard } from "./ai/agents/history-reader";

/** Bump when older embedded collectors can no longer provide trustworthy input. */
export const BOOKMARKLET_VERSION = 2;

/** Self-contained because this function is serialized into the bookmarklet. */
export function collectHistoryCards(doc: Document, base: string, page: number): PageCard[] {
  const imgSrc = (img: HTMLImageElement, base: string) => {
    const raw =
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("data-a-hires") ||
      (img.getAttribute("srcset") || img.getAttribute("data-srcset") || "").split(",").pop()?.trim().split(" ")[0] ||
      img.currentSrc ||
      img.getAttribute("src") ||
      "";
    if (!raw || raw.startsWith("data:")) return null;
    try {
      const href = new URL(raw, base).href;
      return href.length <= 2000 ? href : null;
    } catch {
      return null;
    }
  };

  const text = (el: Element | null, n: number) => ((el as HTMLElement | null)?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, n);

  const sectionOf = (el: Element) => {
    const scope = /(購入済み|購入履歴|購入した商品|購入した作品|注文履歴|注文済み|購入日|注文日|注文日時|課金日|発送済み|出荷済み|配送済み|配達済み|お届け済み|ライブラリ|本棚|bookshelf|your orders|owned|library|ordered on|order date|order placed|order history|delivered|purchased|おすすめ|オススメ|お薦め|ランキング|売れ筋|関連商品|広告|スポンサー|最近チェック|閲覧履歴|もう一度買う|次に読む|好みが似た|recommend|related|sponsored|ranking|popular|best sellers|recently viewed|browsing history|suggested|buy again|you may|you might|customers.*(?:bought|viewed))/i;
    const label = (node: Element): string => {
      if (node.matches("a,button,input,select")) return "";
      const t = text(node, 201);
      if (t.length > 200) return "";
      if (node.querySelector("img") && !node.matches('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
        const heading = node.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
        return heading ? label(heading) : "";
      }
      if (!scope.test(t)) return "";
      // Order headers can include names and order numbers; retain only their UI label.
      return t.match(/購入日|注文日時?|課金日|order date|order placed/i)?.[0] ?? t;
    };
    // Walk boundaries from the inside out. Never inherit the page's purchase heading
    // before checking the nearer recommendation container (including plain div labels).
    let node: Element | null = el;
    while (node && node !== doc.body) {
      const aria = node.getAttribute("aria-label");
      if (aria && scope.test(aria)) return aria.slice(0, 200);
      const labelled = node.getAttribute("aria-labelledby");
      if (labelled) {
        for (const id of labelled.split(/\s+/)) {
          const target = doc.getElementById(id);
          if (target && label(target)) return label(target);
        }
      }
      // A heading/header may be the first child of an order or section wrapper.
      for (const child of (node === el ? [] : [...node.children].slice(0, 3))) {
        if (child.contains(el)) break;
        const t = label(child);
        if (t) return t;
      }
      for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
        const t = label(prev);
        if (t) return t;
        // Do not cross another product list looking for a heading.
        if (prev.querySelector("img")) break;
      }
      node = node.parentElement;
    }
    return "";
  };

  const cardOf = (a: Element) => {
    // Smallest ancestor that looks like a product card (has an image) without being the whole list.
    let node: Element | null = a;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const len = text(node, 2000).length;
      if (len > 700) break;
      if (node.querySelector("img")) return node;
    }
    return a.parentElement || a;
  };

  const cards: PageCard[] = [];
  const seen = new Set<string>();
  const add = (a: Element, href: string, card: Element) => {
    const t = (text(a, 200) || a.getAttribute("alt") || a.querySelector("img")?.getAttribute("alt") || a.getAttribute("title") || a.getAttribute("aria-label") || "").trim().slice(0, 200);
    const section = sectionOf(card);
    const key = href + "|" + t + "|" + section;
    if (seen.has(key) || cards.length >= 1500) return;
    seen.add(key);
    const imgs: { src: string; alt: string }[] = [];
    card.querySelectorAll("img").forEach((img) => {
      const src = imgSrc(img as HTMLImageElement, base);
      if (src && imgs.length < 4 && !imgs.some((i) => i.src === src)) imgs.push({ src, alt: (img.getAttribute("alt") || "").slice(0, 200) });
    });
    cards.push({ href, text: t, context: text(card, 300), section, imgs, page });
  };
  doc.querySelectorAll("a[href]").forEach((a) => {
    try {
      const href = new URL(a.getAttribute("href") || "", base).href;
      // Multi-kilobyte URLs are ad and tracking redirects; the server drops them too.
      if (/^https?:/.test(href) && href.length <= 2000) add(a, href, cardOf(a));
    } catch { /* Ignore invalid links. */ }
  });
  // SPA libraries often open products through a click handler, with no anchor at all.
  // Read their visible card; never execute handlers or inspect framework state.
  doc.querySelectorAll("img").forEach((img) => {
    if (img.closest("a[href]")) return;
    let node = img.parentElement;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      if (node.querySelectorAll("img").length > 1) break;
      if (node.matches('li,article,[role="listitem"],[role="button"]') && !node.querySelector("a[href]")) {
        const title = (img.getAttribute("alt") || "").trim();
        if (title.length >= 2 && text(node, 1000).includes(title.slice(0, 40))) add(img, "", node);
        break;
      }
    }
  });
  return cards;
}

/**
 * Source of the import bookmarklet. It runs on the shop's purchase-history page in the user's own
 * logged-in browser and only *reads* the page:
 *   1. scrolls to load lazily rendered lists,
 *   2. follows "next page" links on the same origin (up to MAX_PAGES),
 *   3. collects every link as a "card": link text, surrounding card text, nearest section heading
 *      and image candidates (including lazy-loaded `data-src` / `srcset`),
 * then hands the payload to the 推し棚 receiver window via postMessage. No credentials are read.
 */
function bookmarkletMain(ORIGIN: string, collectCards: typeof collectHistoryCards, version: number, mode: "remote" | "embedded") {
  if (document.getElementById("oshishelf-import-progress")) return;
  const MAX_PAGES = 10;
  const MAX_CARDS = 1500;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const badge = document.createElement("div");
  badge.id = "oshishelf-import-progress";
  badge.style.cssText =
    "position:fixed;z-index:2147483647;top:12px;right:12px;padding:10px 14px;border-radius:12px;background:#e2567a;color:#fff;font:bold 13px sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)";
  const say = (t: string) => (badge.textContent = `推し棚: ${t}`);
  document.body.appendChild(badge);

  const cards: PageCard[] = [];
  const seen = new Set<string>();
  const text = (el: Element | null, n: number) => ((el as HTMLElement | null)?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, n);
  const collect = (doc: Document, base: string, page: number) => {
    for (const card of collectCards(doc, base, page)) {
      const key = card.href + "|" + card.text + "|" + card.section;
      if (cards.length >= MAX_CARDS || seen.has(key)) continue;
      seen.add(key);
      cards.push(card);
    }
  };

  const nextLink = (doc: Document, base: string) => {
    const cand =
      doc.querySelector('a[rel="next"]') ||
      [...doc.querySelectorAll("a[href]")].find((a) => /^(次へ|次のページ|次|Next|›|»|>)\s*[→>›»]?$/i.test(text(a, 20)));
    if (!cand) return null;
    try {
      const u = new URL(cand.getAttribute("href") || "", base);
      return u.origin === location.origin ? u.href : null;
    } catch {
      return null;
    }
  };

  (async () => {
    // 1. Load lazily rendered lists (infinite scroll) on the current page.
    let last = 0;
    for (let i = 0; i < 15; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      say(`ページを読み込み中…（${i + 1}）`);
      await sleep(700);
      if (document.body.scrollHeight === last) break;
      last = document.body.scrollHeight;
    }
    window.scrollTo(0, 0);
    collect(document, location.href, 1);

    // 2. Follow "next page" links on the same site (paginated order histories).
    let next = nextLink(document, location.href);
    const visited = new Set([location.href]);
    for (let p = 2; next && p <= MAX_PAGES && !visited.has(next); p++) {
      visited.add(next);
      say(`${p}ページ目を読み込み中…`);
      try {
        const html = await (await fetch(next, { credentials: "include" })).text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        collect(doc, next, p);
        next = nextLink(doc, next);
      } catch {
        break;
      }
      await sleep(800);
    }

    say(`${cards.length}件のリンクを推し棚に送ります`);
    const payload = { type: "oshishelf:cards", version, mode, page: location.href, title: document.title.slice(0, 200), cards };
    const w = window.open(ORIGIN + "/import/receive", "oshishelf_import");
    if (!w) {
      say("ポップアップを許可してください");
      return;
    }
    const onMsg = (e: MessageEvent) => {
      if (e.source === w && e.origin === ORIGIN && e.data === "oshishelf:ready") {
        w.postMessage(payload, ORIGIN);
        window.removeEventListener("message", onMsg);
        setTimeout(() => badge.remove(), 2000);
      }
    };
    window.addEventListener("message", onMsg);
  })();
}

/** The stable launcher fetches the current collector on every invocation. */
function bookmarkletLoader(ORIGIN: string, fallback: () => void) {
  if (document.getElementById("oshishelf-bookmarklet-loader") || document.getElementById("oshishelf-import-progress")) return;
  // Open while the bookmark click still has user activation; re-use this named window later.
  if (!window.open(ORIGIN + "/import/receive", "oshishelf_import")) {
    alert("推し棚: ポップアップを許可してから、もう一度ブックマークをクリックしてください");
    return;
  }
  const script = document.createElement("script");
  script.id = "oshishelf-bookmarklet-loader";
  let settled = false;
  const finish = (failed: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    script.remove();
    // A site's CSP can prohibit external scripts. Use the registered collector without
    // weakening the site's policy, and tell the receiver this is compatibility mode.
    if (failed) fallback();
  };
  const timeout = setTimeout(() => finish(true), 8000);
  script.onload = () => finish(false);
  script.onerror = () => finish(true);
  try {
    script.referrerPolicy = "no-referrer";
    script.crossOrigin = "anonymous";
    script.src = ORIGIN + "/api/bookmarklet";
    document.head.appendChild(script);
  } catch {
    // Trusted Types or another site policy may reject script creation synchronously.
    finish(true);
  }
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Invalid bookmarklet origin");
  return url.origin;
}

/** Public, credential-free JavaScript served by /api/bookmarklet with caching disabled. */
export function bookmarkletScript(origin: string, mode: "remote" | "embedded" = "remote"): string {
  return `(${bookmarkletMain.toString()})(${JSON.stringify(normalizeOrigin(origin))}, ${collectHistoryCards.toString()}, ${BOOKMARKLET_VERSION}, ${JSON.stringify(mode)});`;
}

/** `javascript:` URL: stable launcher plus a CSP-compatible embedded fallback. */
export function bookmarkletHref(origin: string): string {
  const src = `void (${bookmarkletLoader.toString()})(${JSON.stringify(normalizeOrigin(origin))}, () => {${bookmarkletScript(origin, "embedded")}})`;
  return `javascript:${encodeURIComponent(src)}`;
}
