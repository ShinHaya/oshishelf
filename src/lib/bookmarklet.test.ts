import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bookmarkletHref, bookmarkletScript, BOOKMARKLET_VERSION, collectHistoryCards } from "./bookmarklet";

function collect(html: string, url = "https://shop.example/library") {
  const window = new Window({ url });
  window.document.body.innerHTML = html;
  return collectHistoryCards(window.document as unknown as Document, url, 1);
}
const linked = (title: string, href: string) => `<a href="${href}"><img src="/covers/${title}.jpg" alt="${title}">${title}</a>`;

describe("purchase-history card collection", () => {
  it("reads a clickable SPA library card without an anchor", () => {
    const cards = collect(`<h1>購入済み商品</h1><div><ul><li><input type="checkbox"><div><picture><img src="/covers/fiction.jpg" alt="架空の動画"></picture><span>架空の動画</span><button>お気に入り</button></div></li></ul></div>`);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ href: "", text: "架空の動画", section: "購入済み商品", imgs: [{ src: "https://shop.example/covers/fiction.jpg", alt: "架空の動画" }] });
  });

  it.each(["あなたと好みが似た人が見ている商品", "売れ筋ランキング", "あなたが購入した作品からのおすすめ", "もう一度買う", "次に読むものを見つけよう", "Recommended for you", "Buy again"])("recognizes plain div headings: %s", (heading) => {
    const cards = collect(`<h1>購入済み作品</h1><section>${linked("購入作品", "/product/1")}</section><div><div>${heading}</div><div><div>${linked("おすすめ作品", "/product/2")}</div></div></div>`);
    expect(cards.map(c => c.section)).toEqual(["購入済み作品", heading]);
  });

  it("does not mistake words in product titles for section headings", () => {
    const cards = collect(`<h1>購入済み作品</h1><div><a href="/product/1"><img src="/cover.jpg" alt="おすすめの本"><span>おすすめの本</span></a></div><div><h2>おすすめ</h2><a href="/product/2"><img src="/cover2.jpg" alt="購入済みの世界"><span>購入済みの世界</span></a></div>`);
    expect(cards.map(c => c.section)).toEqual(["購入済み作品", "おすすめ"]);
  });

  it("recognizes an enclosing recommendation heading even when its header has an icon", () => {
    const cards = collect(`<h1>注文履歴</h1><div><div><img src="/icon.jpg" alt=""><h2>Recommended for you</h2></div><div>${linked("Fictional Product", "/product/1")}</div></div>`);
    expect(cards.find(c => c.href.endsWith("/product/1"))?.section).toBe("Recommended for you");
  });

  it("does not let a card's image link hide order-level evidence", () => {
    const cards = collect(`<h1>注文履歴</h1><div><div>注文日 2026年1月2日</div><div>${linked("架空の本", "/product/3")}<button>もう一度買う</button></div></div>`);
    expect(cards[0].section).toContain("注文日");
  });

  it.each(["Your Orders", "Bookshelf", "購入した作品", "購入日"])("reads ownership context from other shops: %s", (heading) => {
    expect(collect(`<h1>${heading}</h1><div>${linked("Fictional Product", "/product?id=1")}</div>`)[0].section).toBe(heading);
  });

  it("reads an order header with an auxiliary icon without retaining private fields", () => {
    const cards = collect(`<div><h5>注文日 2026年1月2日 注文番号 TEST-123 お届け先 架空の名前<img src="/icon.png" alt=""></h5><div>${linked("架空の本", "/product/1")}</div></div>`);
    expect(cards.find(c => c.href.endsWith("/product/1"))?.section).toBe("注文日");
  });

  it("keeps both occurrences when the same URL is purchased and recommended", () => {
    const cards = collect(`<h1>購入済み作品</h1><div>${linked("架空作品", "/product/1")}</div><div><p>おすすめ</p><div>${linked("架空作品", "/product/1")}</div></div>`);
    expect(cards).toHaveLength(2);
    expect(cards.map(c => c.section)).toEqual(["購入済み作品", "おすすめ"]);
  });

  it("finds purchase headings beyond eight ancestor wrappers", () => {
    expect(collect(`<h1>購入済み作品</h1>${"<div>".repeat(12)}${linked("架空作品", "/product/1")}${"</div>".repeat(12)}`)[0].section).toBe("購入済み作品");
  });

  it("resolves relative lazy images on fetched pagination pages", () => {
    const cards = collect(`<h1>Owned games</h1><a href="../product/1"><img src="data:image/gif;base64,AA" data-src="../cover.jpg" alt="Fictional Game"></a>`, "https://shop.example/orders/page2/");
    expect(cards[0].imgs[0].src).toBe("https://shop.example/orders/cover.jpg");
  });

  it("bounds long image titles so the bulk payload remains valid", () => {
    const title = "架空の長い作品名".repeat(100);
    expect(collect(`<h1>購入済み作品</h1><ul><li><img src="/cover.jpg" alt="${title}">${title}</li></ul>`)[0].text).toHaveLength(200);
  });

  it("embeds a self-contained collector into the bookmarklet", () => {
    const script = decodeURIComponent(bookmarkletHref("https://shelf.example").slice("javascript:".length));
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('querySelectorAll("img")');
    const window = new Window({ url: "https://shop.example/orders" });
    window.document.body.innerHTML = `<h1>購入済み作品</h1>${linked("架空の作品", "/product/1")}`;
    const serialized = new Function(`return (${collectHistoryCards.toString()})`)() as typeof collectHistoryCards;
    expect(serialized(window.document as unknown as Document, "https://shop.example/orders", 1)[0].section).toBe("購入済み作品");
  });
});


afterEach(() => { vi.useRealTimers(); });

function launcherFixture() {
  vi.useFakeTimers();
  const dom = new Window({ url: "https://shop.example/library", settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true } });
  dom.document.body.innerHTML = `<h1>購入済み作品</h1>${linked("架空の作品", "/product/1")}`;
  // Keep scripts inert in this DOM fixture; tests drive load/error events themselves.
  const append = dom.document.head.appendChild.bind(dom.document.head);
  vi.spyOn(dom.document.head, "appendChild").mockImplementation((node) => {
    (node as unknown as HTMLScriptElement).type = "application/json";
    return append(node);
  });
  const receiver = { postMessage: vi.fn() };
  const browser = { open: vi.fn(() => receiver), scrollTo: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const alert = vi.fn();
  const run = (script: string) => new Function("window", "document", "location", "alert", "setTimeout", "clearTimeout", script)(browser, dom.document, dom.location, alert, setTimeout, clearTimeout);
  const launch = () => run(decodeURIComponent(bookmarkletHref("https://shelf.example").slice("javascript:".length)));
  return { dom, browser, receiver, alert, run, launch };
}

describe("automatically updated bookmarklet launcher", () => {
  it("opens the receiver during the click and loads current public code without a history referrer", () => {
    const f = launcherFixture();
    f.launch();
    expect(f.browser.open).toHaveBeenCalledWith("https://shelf.example/import/receive", "oshishelf_import");
    const script = f.dom.document.querySelector("script")!;
    expect(script.src).toBe("https://shelf.example/api/bookmarklet");
    expect(script.referrerPolicy).toBe("no-referrer");
    expect(script.crossOrigin).toBe("anonymous");
  });

  it("loads the server's latest collector on each invocation, without changing the bookmark URL", () => {
    const f = launcherFixture();
    f.launch();
    const first = f.dom.document.querySelector("script")!;
    first.dispatchEvent(new f.dom.Event("load"));
    expect(first.isConnected).toBe(false);
    f.launch();
    const second = f.dom.document.querySelector("script")!;
    expect(second).not.toBe(first);
    expect(second.src).toBe(first.src);
  });

  it("does not start two simultaneous downloads", () => {
    const f = launcherFixture();
    f.launch();
    f.launch();
    expect(f.dom.document.querySelectorAll("script")).toHaveLength(1);
    expect(f.browser.open).toHaveBeenCalledTimes(1);
  });

  it("asks for popup permission instead of silently starting a blocked import", () => {
    const f = launcherFixture();
    f.browser.open.mockReturnValueOnce(null as never);
    f.launch();
    expect(f.alert).toHaveBeenCalledOnce();
    expect(f.dom.document.querySelector("script")).toBeNull();
  });

  it.each(["error", "timeout"])("uses an embedded collector when external loading fails: %s", async (failure) => {
    const f = launcherFixture();
    f.launch();
    const script = f.dom.document.querySelector("script")!;
    if (failure === "error") script.dispatchEvent(new f.dom.Event("error"));
    else await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(700);
    expect(f.dom.document.querySelector("script")).toBeNull();
    expect(f.browser.addEventListener).toHaveBeenCalledOnce();
    const callback = f.browser.addEventListener.mock.calls[0][1];
    callback({ source: f.receiver, origin: "https://shelf.example", data: "oshishelf:ready" });
    expect(f.receiver.postMessage).toHaveBeenCalledWith(expect.objectContaining({ version: BOOKMARKLET_VERSION, mode: "embedded", cards: expect.arrayContaining([expect.objectContaining({ text: "架空の作品", section: "購入済み作品" })]) }), "https://shelf.example");
  });

  it("runs downloaded code, sends a current payload and ignores ready messages from other windows", async () => {
    const f = launcherFixture();
    f.launch();
    f.run(bookmarkletScript("https://shelf.example"));
    f.dom.document.querySelector("script")!.dispatchEvent(new f.dom.Event("load"));
    await vi.advanceTimersByTimeAsync(700);
    const callback = f.browser.addEventListener.mock.calls[0][1];
    callback({ source: {}, origin: "https://shelf.example", data: "oshishelf:ready" });
    expect(f.receiver.postMessage).not.toHaveBeenCalled();
    callback({ source: f.receiver, origin: "https://attacker.example", data: "oshishelf:ready" });
    expect(f.receiver.postMessage).not.toHaveBeenCalled();
    callback({ source: f.receiver, origin: "https://shelf.example", data: "oshishelf:ready" });
    expect(f.receiver.postMessage).toHaveBeenCalledWith(expect.objectContaining({ version: BOOKMARKLET_VERSION, mode: "remote" }), "https://shelf.example");
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.browser.open).toHaveBeenCalledTimes(2); // click + collector, no timeout fallback
  });

  it("falls back when site policy rejects script insertion synchronously", async () => {
    const f = launcherFixture();
    vi.spyOn(f.dom.document.head, "appendChild").mockImplementation(() => { throw new Error("site policy blocked"); });
    expect(() => f.launch()).not.toThrow();
    await vi.advanceTimersByTimeAsync(700);
    expect(f.browser.addEventListener).toHaveBeenCalledOnce();
  });

  it("does not run a late downloaded collector a second time after timeout fallback", async () => {
    const f = launcherFixture();
    f.launch();
    await vi.advanceTimersByTimeAsync(8000);
    f.run(bookmarkletScript("https://shelf.example"));
    await vi.advanceTimersByTimeAsync(700);
    expect(f.browser.addEventListener).toHaveBeenCalledTimes(1);
    expect(f.dom.document.querySelectorAll("#oshishelf-import-progress")).toHaveLength(1);
  });

  it.each(["javascript:alert(1)", "https://user:password@shelf.example"])("rejects an unsafe launcher origin: %s", (origin) => {
    expect(() => bookmarkletHref(origin)).toThrow("Invalid bookmarklet origin");
  });
});
