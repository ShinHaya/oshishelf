import { expect, it } from "vitest";
import { notificationProductLinks } from "./notification-links";
import type { Notification } from "./types";

const notification: Notification = { id: "fictional", kind: "new_release", title: "架空の新作", body: "おすすめ", url: "https://www.amazon.co.jp/dp/B012345678", read: false, createdAt: 0 };

it("shows a shop button for legacy notifications without productLinks", () => {
  expect(notificationProductLinks(notification)).toEqual([{ shop: "amazon", label: "Amazon", url: notification.url }]);
});

it("keeps multiple stores and deduplicates the primary store using the actual URL", () => {
  expect(notificationProductLinks({ ...notification, productLinks: [
    { shop: "wrong", label: "不正な表示", url: `${notification.url}?tag=tracking` },
    { shop: "rakuten", label: "楽天", url: "https://books.rakuten.co.jp/rb/123456/" },
  ] })).toEqual([
    { shop: "amazon", label: "Amazon", url: notification.url },
    { shop: "rakuten", label: "楽天", url: "https://books.rakuten.co.jp/rb/123456/" },
  ]);
});

it("excludes search results, unknown hosts and unsafe URLs", () => {
  const urls = ["https://www.amazon.co.jp/s?k=fiction", "https://evil.example/dp/B012345678", "javascript:alert(1)", "https://user:secret@www.amazon.co.jp/dp/B012345678"];
  expect(notificationProductLinks({ ...notification, url: null, productLinks: urls.map((url) => ({ shop: "amazon", label: "Amazon", url })) })).toEqual([]);
});

it("does not add product buttons to social notifications", () => {
  expect(notificationProductLinks({ ...notification, kind: "follow" })).toEqual([]);
});
