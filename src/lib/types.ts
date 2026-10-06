export type Visibility = "public" | "followers" | "private";
export type ItemStatus = "draft" | "published";
export type Category = "book" | "comic" | "video" | "game" | "music" | "goods" | "other";
export type GuardLevel = "ok" | "warn" | "block";
export type ImportSource = "url" | "screenshot" | "bulk" | "paste" | "manual";

export const CATEGORY_LABELS: Record<Category, string> = {
  book: "書籍",
  comic: "マンガ",
  video: "動画",
  game: "ゲーム",
  music: "音楽",
  goods: "グッズ",
  other: "その他",
};

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  public: "全体公開",
  followers: "フォロワーのみ",
  private: "自分のみ",
};

export interface GuardResult {
  level: GuardLevel;
  reasons: string[];
  suggestedVisibility: Visibility;
  checkedAt: number;
}

export interface Item {
  id: string;
  ownerUid: string;
  url: string;
  /** True when `url` is a shop search page rather than the exact product page. */
  urlIsSearch: boolean;
  shop: string;
  shopLabel: string;
  title: string;
  imageUrl: string | null;
  price: number | null;
  category: Category;
  tags: string[];
  isAdult: boolean;
  visibility: Visibility;
  status: ItemStatus;
  guard: GuardResult | null;
  note: string;
  source: ImportSource;
  clickCount: number;
  createdAt: number;
  publishedAt: number | null;
}

export interface AiBioVariant {
  text: string;
  catchphrase: string;
  traits: string[];
}

export interface AiBio extends AiBioVariant {
  generatedAt: number;
  /**
   * Version "A" that also reflects the owner's R18 items (genres/tags only). Shown only to viewers
   * who opted in to R18 display, and only while the owner allows AI to use their R18 items.
   */
  adult?: AiBioVariant | null;
}

export interface UserProfile {
  uid: string;
  handle: string;
  displayName: string;
  bio: string;
  aiBio: AiBio | null;
  /** Latest AI-generated bio awaiting the user's approval (human-in-the-loop). */
  aiBioDraft: AiBio | null;
  avatarHue: number;
  /** Self-declared 18+; required before R18 items can be shown. */
  isAdult: boolean;
  showAdult: boolean;
  /** Owner consent: let AI features (bio / twin / compatibility) use this user's R18 items as genres & tags. */
  aiUseAdult: boolean;
  defaultVisibility: Visibility;
  twinEnabled: boolean;
  tasteTags: string[];
  followerCount: number;
  followingCount: number;
  itemCount: number;
  createdAt: number;
}

export interface Wish {
  itemId: string;
  ownerUid: string;
  url: string;
  title: string;
  imageUrl: string | null;
  shop: string;
  shopLabel: string;
  lastPrice: number | null;
  watch: boolean;
  createdAt: number;
  lastCheckedAt: number | null;
}

export interface Notification {
  id: string;
  kind: "price_drop" | "new_release" | "follow" | "agent";
  title: string;
  body: string;
  url: string | null;
  read: boolean;
  createdAt: number;
}

/** A product candidate produced by an import path before it is stored as a draft. */
export interface ImportCandidate {
  url: string;
  urlIsSearch?: boolean;
  title: string;
  imageUrl?: string | null;
  price?: number | null;
  shopHint?: string;
}
