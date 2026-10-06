/**
 * Source of the import bookmarklet. It runs on the shop's purchase-history page in the user's own
 * logged-in browser and only *reads* the page:
 *   1. scrolls to load lazily rendered lists,
 *   2. follows "next page" links on the same origin (up to MAX_PAGES),
 *   3. collects every link as a "card": link text, surrounding card text, nearest section heading
 *      and image candidates (including lazy-loaded `data-src` / `srcset`),
 * then hands the payload to the 推し棚 receiver window via postMessage. No credentials are read.
 */
function bookmarkletMain(ORIGIN: string) {
  const MAX_PAGES = 10;
  const MAX_CARDS = 1500;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const badge = document.createElement("div");
  badge.style.cssText =
    "position:fixed;z-index:2147483647;top:12px;right:12px;padding:10px 14px;border-radius:12px;background:#e2567a;color:#fff;font:bold 13px sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)";
  const say = (t: string) => (badge.textContent = `推し棚: ${t}`);
  document.body.appendChild(badge);

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
      return new URL(raw, base).href;
    } catch {
      return null;
    }
  };

  const text = (el: Element | null, n: number) => ((el as HTMLElement | null)?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, n);

  const sectionOf = (el: Element) => {
    // Nearest heading above the card: walks up and looks at preceding headings / aria labels.
    let node: Element | null = el;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const label = node.getAttribute("aria-label");
      if (label && label.length < 80) return label;
      let prev = node.previousElementSibling;
      for (let i = 0; prev && i < 4; i++, prev = prev.previousElementSibling) {
        const h = prev.matches("h1,h2,h3,h4") ? prev : prev.querySelector("h1,h2,h3,h4");
        if (h) return text(h, 80);
      }
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

  type Card = { href: string; text: string; context: string; section: string; imgs: { src: string; alt: string }[]; page: number };
  const cards: Card[] = [];
  const seen = new Set<string>();

  const collect = (doc: Document, base: string, page: number) => {
    doc.querySelectorAll("a[href]").forEach((a) => {
      if (cards.length >= MAX_CARDS) return;
      let href: string;
      try {
        href = new URL(a.getAttribute("href") || "", base).href;
      } catch {
        return;
      }
      if (!/^https?:/.test(href)) return;
      const card = cardOf(a);
      const t = text(a, 200) || (a.querySelector("img")?.getAttribute("alt") ?? "") || a.getAttribute("title") || a.getAttribute("aria-label") || "";
      const key = href + "|" + t;
      if (seen.has(key)) return;
      seen.add(key);
      const imgs: { src: string; alt: string }[] = [];
      card.querySelectorAll("img").forEach((img) => {
        const src = imgSrc(img as HTMLImageElement, base);
        if (src && imgs.length < 4 && !imgs.some((i) => i.src === src)) imgs.push({ src, alt: (img.getAttribute("alt") || "").slice(0, 120) });
      });
      cards.push({ href, text: t, context: text(card, 300), section: sectionOf(card), imgs, page });
    });
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
    const payload = { type: "oshishelf:cards", page: location.href, title: document.title.slice(0, 200), cards, text: text(document.body, 60000) };
    const w = window.open(ORIGIN + "/import/receive", "oshishelf_import");
    if (!w) {
      say("ポップアップを許可してください");
      return;
    }
    const onMsg = (e: MessageEvent) => {
      if (e.origin === ORIGIN && e.data === "oshishelf:ready") {
        w.postMessage(payload, ORIGIN);
        window.removeEventListener("message", onMsg);
        setTimeout(() => badge.remove(), 2000);
      }
    };
    window.addEventListener("message", onMsg);
  })();
}

/** `javascript:` URL for the bookmarklet, bound to the app origin. */
export function bookmarkletHref(origin: string): string {
  // Function#toString yields the compiled JS of bookmarkletMain; wrap it as an IIFE.
  const src = `(${bookmarkletMain.toString()})(${JSON.stringify(origin)})`;
  return `javascript:${encodeURIComponent(src)}`;
}
