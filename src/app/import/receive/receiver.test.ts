import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState), useEffect: vi.fn(), useTransition: () => [false, vi.fn()] };
});
vi.mock("@/app/actions", () => ({ importBulkAction: vi.fn(), importPasteAction: vi.fn(), importScreenshotAction: vi.fn(), importUrlsAction: vi.fn() }));
import { createElement, useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOOKMARKLET_VERSION, bookmarkletHref } from "@/lib/bookmarklet";
import { Receiver } from "./receiver";

beforeEach(() => { vi.mocked(useState).mockClear(); vi.mocked(useEffect).mockClear(); });
afterEach(() => vi.unstubAllGlobals());

function render(payload: Record<string, unknown> | null, setter = vi.fn()) {
  vi.mocked(useState).mockReturnValueOnce([payload, setter]).mockReturnValueOnce([null, vi.fn()]);
  return renderToStaticMarkup(createElement(Receiver, { bookmarklet: bookmarkletHref("https://shelf.example"), version: BOOKMARKLET_VERSION }));
}
const legacy = { type: "oshishelf:cards", page: "https://shop.example/orders", origin: "https://shop.example", cards: [] };

describe("one-time migration from embedded legacy bookmarklets", () => {
  it.each([undefined, BOOKMARKLET_VERSION - 1, BOOKMARKLET_VERSION + 1])("requires a current collector before importing version %s", (version) => {
    const html = render({ ...legacy, version });
    expect(html).toContain("更新用URLをコピー");
    expect(html).not.toMatch(/<button[^>]*>取り込む<\/button>/);
  });

  it("accepts the automatically downloaded current collector", () => {
    const html = render({ ...legacy, version: BOOKMARKLET_VERSION, mode: "remote" });
    expect(html).toMatch(/<button[^>]*>取り込む<\/button>/);
    expect(html).not.toContain("更新用URLをコピー");
  });

  it("keeps compatibility imports available while disclosing the lack of automatic updates", () => {
    const html = render({ ...legacy, version: BOOKMARKLET_VERSION, mode: "embedded" });
    expect(html).toMatch(/<button[^>]*>取り込む<\/button>/);
    expect(html).toContain("登録時の読み取り処理");
  });
});


it("shows actual link destinations for confirmation", () => {
  const html = render({ ...legacy, version: BOOKMARKLET_VERSION, cards: [{ href: "https://other.example/product", text: "架空作品", context: "", section: "購入履歴", imgs: [], page: 1 }] });
  expect(html).toContain("shop.example から取り込み");
  expect(html).toContain("https://other.example/product");
  expect(html).toContain("取り込み対象のリンクを確認");
});


it("accepts only its opener and freezes the confirmed payload against later replacement", () => {
  let listener: (event: MessageEvent) => void = () => {};
  const opener = { postMessage: vi.fn() };
  const setter = vi.fn();
  vi.stubGlobal("window", { opener, addEventListener: (_type: string, fn: typeof listener) => { listener = fn; }, removeEventListener: vi.fn() });
  render(null, setter);
  vi.mocked(useEffect).mock.calls[0][0]();
  const data = { ...legacy, version: BOOKMARKLET_VERSION };
  const send = (source: unknown, origin: string) => listener({ source, origin, data } as MessageEvent);
  send({}, "https://shop.example");
  send(opener, "https://evil.example");
  expect(setter).not.toHaveBeenCalled();
  send(opener, "https://shop.example");
  expect(setter).toHaveBeenCalledTimes(1);
  const update = setter.mock.calls[0][0];
  const first = update(null);
  expect(first.origin).toBe("https://shop.example");
  expect(update(first)).toBe(first);
  expect(opener.postMessage).toHaveBeenCalledWith("oshishelf:ready", "*");
});
