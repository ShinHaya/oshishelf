import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState), useEffect: vi.fn(), useTransition: () => [false, vi.fn()] };
});
vi.mock("@/app/actions", () => ({ importBulkAction: vi.fn(), importPasteAction: vi.fn(), importScreenshotAction: vi.fn(), importUrlsAction: vi.fn() }));
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOOKMARKLET_VERSION, bookmarkletHref } from "@/lib/bookmarklet";
import { Receiver } from "./receiver";

beforeEach(() => { vi.mocked(useState).mockClear(); });

function render(payload: Record<string, unknown>) {
  vi.mocked(useState).mockReturnValueOnce([payload, vi.fn()]).mockReturnValueOnce([null, vi.fn()]);
  return renderToStaticMarkup(createElement(Receiver, { bookmarklet: bookmarkletHref("https://shelf.example"), version: BOOKMARKLET_VERSION }));
}
const legacy = { type: "oshishelf:cards", page: "https://shop.example/orders", cards: [] };

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
