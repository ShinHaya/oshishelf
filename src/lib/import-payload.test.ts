import { describe, expect, it } from "vitest";
import { parseImportMessage } from "./import-payload";
const payload = { type: "oshishelf:cards", version: 8, page: "https://www.amazon.co.jp/orders", cards: [{ href: "https://www.amazon.co.jp/dp/B000000001", text: "架空の作品", context: "注文日", section: "購入履歴", imgs: [], page: 1 }] };
describe("bookmarklet sender validation", () => {
  it("uses the real origin and retains valid purchase cards", () => {
    expect(parseImportMessage(payload, "https://www.amazon.co.jp")).toMatchObject({ origin: "https://www.amazon.co.jp", cards: payload.cards });
  });
  it.each(["https://evil.example", "http://www.amazon.co.jp", "https://www.amazon.co.jp:8443", "null", "not a URL"])("rejects origin spoofing: %s", (origin) => {
    expect(parseImportMessage(payload, origin)).toBeNull();
  });
  it.each([null, {}, { ...payload, cards: "not cards" }, { ...payload, cards: [{ ...payload.cards[0], href: "javascript:alert(1)" }] }, { ...payload, page: "data:text/html,hello" }])("rejects malformed payloads before display", (data) => {
    expect(parseImportMessage(data, "https://www.amazon.co.jp")).toBeNull();
  });
  it("supports old links and title-only cards with bounded data", () => {
    expect(parseImportMessage({ ...payload, cards: [{ ...payload.cards[0], href: "" }] }, "https://www.amazon.co.jp")).not.toBeNull();
    expect(parseImportMessage({ type: "oshishelf:links", page: payload.page, links: [{ href: payload.cards[0].href, text: "架空", img: null }] }, "https://www.amazon.co.jp")).not.toBeNull();
  });
});


it("drops oversized tracking cards and images instead of rejecting real purchase cards", () => {
  const tracking = "https://shop.example/tracking?" + "x".repeat(2000);
  const data = parseImportMessage({ ...payload, cards: [{ ...payload.cards[0], imgs: [{ src: tracking, alt: "" }] }, { ...payload.cards[0], href: tracking }] }, "https://www.amazon.co.jp");
  expect(data?.cards).toEqual([{ ...payload.cards[0], imgs: [] }]);
});
