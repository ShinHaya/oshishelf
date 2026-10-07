import type { Item, UserProfile } from "./types";

export function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1", ownerUid: "owner", url: "https://example.com/product/1",
    urlIsSearch: false, shop: "example", shopLabel: "Example", title: "作品タイトル",
    imageUrl: "https://example.com/image.jpg", price: 1000, category: "book",
    tags: ["SF"], isAdult: false, visibility: "public", status: "published",
    guard: null, note: "個人的なメモ", review: null, source: "manual", clickCount: 0,
    createdAt: 1, publishedAt: 2, ...overrides,
  };
}

export function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    uid: "viewer", handle: "viewer", displayName: "Viewer", bio: "",
    aiBio: null, aiBioDraft: null, avatarHue: 0, isAdult: false, showAdult: false,
    aiUseAdult: false, defaultVisibility: "private", twinEnabled: false,
    tasteTags: [], followerCount: 0, followingCount: 0, itemCount: 0,
    createdAt: 1, ...overrides,
  };
}
