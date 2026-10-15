import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ run: vi.fn(), notify: vi.fn(), find: vi.fn(), generate: vi.fn(), add: vi.fn(), wishes: vi.fn(), meta: vi.fn() }));
vi.mock("@google/adk", () => ({
  FunctionTool: class { constructor(public config: unknown) { Object.assign(this, config); } },
  LlmAgent: class { constructor(public config: unknown) { Object.assign(this, config); } },
}));
vi.mock("../adk", () => ({ adkModel: vi.fn(), runAgent: m.run }));
vi.mock("../gemini", () => ({ MODEL: "fake", genai: { models: { generateContent: m.generate } } }));
vi.mock("../../firebase-admin", () => ({ db: { collection: () => ({ add: m.add }) } }));
vi.mock("../../data/users", () => ({ getUser: async () => ({ uid: "fictional", tasteTags: ["冒険"] }), getImportedShops: async () => ["amazon", "rakuten", "fanza"] }));
vi.mock("../../data/social", () => ({ listNotifications: async () => [], listVisibleWishes: m.wishes, notify: m.notify, updateWish: vi.fn() }));
vi.mock("../../product-meta", () => ({ fetchProductMeta: m.meta }));
vi.mock("../../recommendation-products", async (original) => ({ ...await original<typeof import("../../recommendation-products")>(), findRecommendationProducts: m.find }));
import { runWatcherFor } from "./watcher";
type Tool = { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  m.wishes.mockResolvedValue([]);
  m.generate.mockResolvedValue({ text: "架空の作品 | 2026-10-01 | 新作" });
  m.find.mockResolvedValue([{ shop: "rakuten", label: "楽天", url: "https://books.rakuten.co.jp/rb/123456/" }]);
});

it("only notifies searched releases with verified direct links, ignoring a forged itemId", async () => {
  m.run.mockImplementation(async (agent: { tools: Tool[] }) => {
    const call = (name: string, args: Record<string, unknown>) => agent.tools.find((t) => t.name === name)!.execute(args);
    await call("notify_user", { kind: "new_release", title: "偽", body: "偽", releaseTitle: "未検索" });
    expect(m.notify).not.toHaveBeenCalled();
    await call("search_new_releases", { keyword: "冒険" });
    await call("notify_user", { kind: "new_release", title: "新作", body: "おすすめ", releaseTitle: "架空の作品", itemId: "forged" });
    return { text: "完了", steps: [] };
  });
  await runWatcherFor("fictional");
  expect(m.find).toHaveBeenCalledWith("架空の作品", ["amazon", "rakuten"], false);
  expect(m.notify).toHaveBeenCalledWith("fictional", expect.objectContaining({ url: "https://books.rakuten.co.jp/rb/123456/", productLinks: expect.any(Array) }));
});

it("does not publish a search URL when no store has a verified product", async () => {
  m.find.mockResolvedValue([]);
  m.run.mockImplementation(async (agent: { tools: Tool[] }) => {
    await agent.tools.find((t) => t.name === "search_new_releases")!.execute({ keyword: "冒険" });
    await agent.tools.find((t) => t.name === "notify_user")!.execute({ kind: "new_release", title: "新作", body: "おすすめ", releaseTitle: "架空の作品" });
    return { text: "完了", steps: [] };
  });
  await runWatcherFor("fictional");
  expect(m.notify).not.toHaveBeenCalled();
});


it("keeps the verified price-drop store as the primary link even when other shops match", async () => {
  const url = "https://books.rakuten.co.jp/rb/123456/";
  m.wishes.mockResolvedValue([{ itemId: "fictional-item", shop: "rakuten", shopLabel: "楽天", title: "架空の作品", url, isAdult: false, category: "book", lastPrice: 100, watch: true }]);
  m.meta.mockResolvedValue({ price: 90 });
  m.find.mockResolvedValue([{ shop: "amazon", label: "Amazon", url: "https://www.amazon.co.jp/dp/B012345678" }, { shop: "rakuten", label: "楽天", url }]);
  m.run.mockImplementation(async (agent: { tools: Tool[] }) => {
    await agent.tools.find((t) => t.name === "check_price")!.execute({ itemId: "fictional-item" });
    await agent.tools.find((t) => t.name === "notify_user")!.execute({ kind: "price_drop", title: "値下がり", body: "おすすめ", itemId: "fictional-item" });
    return { text: "完了", steps: [] };
  });
  await runWatcherFor("fictional");
  expect(m.notify).toHaveBeenCalledWith("fictional", expect.objectContaining({ url, productLinks: [{ shop: "rakuten", label: "楽天", url }, { shop: "amazon", label: "Amazon", url: "https://www.amazon.co.jp/dp/B012345678" }] }));
});
