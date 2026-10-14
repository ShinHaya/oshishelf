import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { makeItem, makeProfile } from "../../test-fixtures";
import type { Item, UserProfile } from "../../types";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), listShelf: vi.fn(), runAgentJson: vi.fn(), set: vi.fn(), get: vi.fn(), agent: vi.fn() }));
vi.mock("@google/adk", () => ({
  LlmAgent: class { constructor(options: unknown) { mocks.agent(options); } },
  FunctionTool: class { constructor(options: object) { Object.assign(this, options); } },
}));
vi.mock("../adk", () => ({ adkModel: () => "fictional-model", runAgentJson: mocks.runAgentJson }));
vi.mock("../gemini", () => ({ SAFETY_SETTINGS: [] }));
vi.mock("../../firebase-admin", () => ({ db: { collection: () => ({ doc: (id: string) => ({ get: () => mocks.get(id), set: (data: unknown) => mocks.set(id, data) }) }) } }));
vi.mock("../../data/items", () => ({ listShelf: mocks.listShelf }));
vi.mock("../../data/social", () => ({ listFollowing: vi.fn() }));
vi.mock("../../data/users", () => ({ getUser: mocks.getUser, findSimilarUsers: vi.fn(), getTasteVector: vi.fn() }));
import { analyzeCompatibility, getCachedCompatibility } from "./matcher";
let profiles: Map<string, UserProfile>;
let shelves: Map<string, Item[]>;
let docs: Map<string, Record<string, unknown>>;
let viewer: UserProfile;
let target: UserProfile;
const output = { data: { score: 75, summary: "架空作品の共通点", sharedPoints: ["架空作品"], picks: [{ itemId: "target-item", reason: "架空のおすすめ" }, { itemId: "invented", reason: "存在しない" }], icebreakers: ["架空作品について話しましょう"] }, steps: [{ tool: "search_their_shelf", args: { query: "架空作品" } }] };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T01:00:00Z"));
  vi.clearAllMocks();
  viewer = makeProfile({ uid: "viewer" });
  target = makeProfile({ uid: "target", displayName: "架空の相手" });
  profiles = new Map([[viewer.uid, viewer], [target.uid, target]]);
  shelves = new Map([["viewer", [makeItem({ id: "viewer-item", ownerUid: "viewer" })]], ["target", [makeItem({ id: "target-item", ownerUid: "target", title: "架空作品" })]]]);
  docs = new Map();
  mocks.getUser.mockImplementation(async (uid) => structuredClone(profiles.get(uid) ?? null));
  mocks.listShelf.mockImplementation(async (uid) => structuredClone(shelves.get(uid) ?? []));
  mocks.get.mockImplementation(async (id) => ({ exists: docs.has(id), data: () => docs.get(id) }));
  mocks.set.mockImplementation(async (id, data) => { docs.set(id, data); });
  mocks.runAgentJson.mockResolvedValue(output);
});
afterEach(() => vi.useRealTimers());
const generate = () => analyzeCompatibility(viewer, target, true);
const cached = () => getCachedCompatibility(viewer, target);

describe("compatibility cache privacy", () => {
  it("reuses only a fresh cache bound to current inputs, preserving actual IDs", async () => {
    const result = await generate();
    expect(result.picks).toEqual([{ itemId: "target-item", title: "架空作品", reason: "架空のおすすめ" }]);
    expect(await cached()).toEqual(result);
    expect(await analyzeCompatibility(viewer, target)).toEqual(result);
    expect(mocks.runAgentJson).toHaveBeenCalledTimes(1);
    expect(await cached()).not.toHaveProperty("inputHash");
  });
  it.each(["viewer", "target"])("rejects the whole output after %s withdraws a work", async (owner) => {
    await generate();
    for (const patch of [{ visibility: "private" as const }, { visibility: "followers" as const }, { status: "draft" as const }]) {
      shelves.set(owner, [makeItem({ id: `${owner}-item`, ownerUid: owner, ...patch })]);
      expect(await cached()).toBeNull();
    }
    shelves.set(owner, []);
    expect(await cached()).toBeNull();
  });
  it("rechecks the shelf after reading a cache withdrawn during the read", async () => {
    await generate();
    mocks.get.mockImplementationOnce(async (id) => {
      const data = docs.get(id);
      shelves.set("target", []);
      return { exists: true, data: () => data };
    });
    expect(await cached()).toBeNull();
  });
  it("does not read whole shelves for an absent or expired cache", async () => {
    expect(await cached()).toBeNull();
    expect(mocks.listShelf).not.toHaveBeenCalled();
    await generate();
    mocks.listShelf.mockClear();
    vi.setSystemTime(Date.now() + 86400000);
    expect(await cached()).toBeNull();
    expect(mocks.listShelf).not.toHaveBeenCalled();
  });
  it("rejects changed titles, tags, price, and adult classification", async () => {
    await generate();
    const item = shelves.get("target")![0];
    for (const patch of [{ title: "変更後の作品" }, { tags: ["変更後"] }, { price: 2000 }, { isAdult: true }]) {
      shelves.set("target", [{ ...item, ...patch }]);
      expect(await cached()).toBeNull();
    }
  });
  it("does not invalidate on click counts or private shelf notes", async () => {
    await generate();
    shelves.set("target", shelves.get("target")!.map((i) => ({ ...i, clickCount: 50, note: "別の私的メモ" })));
    expect(await cached()).not.toBeNull();
  });
  it.each([0, 1, 2])("enforces TTL, including the exact boundary %s", async (offset) => {
    await generate();
    vi.setSystemTime(Date.now() + 86400000 + offset - 1);
    expect(await cached()).toEqual(offset === 0 ? expect.any(Object) : null);
  });
  it("rejects legacy caches without input metadata, even when recently generated", async () => {
    docs.set("viewer_target_safe", { ...output.data, steps: output.steps, generatedAt: Date.now() });
    expect(await cached()).toBeNull();
  });
  it("rejects future timestamps and deleted profiles", async () => {
    await generate();
    docs.get("viewer_target_safe")!.generatedAt = Date.now() + 1;
    expect(await cached()).toBeNull();
    profiles.delete("target");
    expect(await cached()).toBeNull();
  });
  it("invalidates partial adult consent changes even when the cache key remains adult", async () => {
    viewer.isAdult = viewer.showAdult = viewer.aiUseAdult = true;
    target.isAdult = target.aiUseAdult = true;
    shelves.get("target")![0].isAdult = true;
    await generate();
    target.aiUseAdult = false; // Viewer still has adult scope; old key alone is insufficient.
    expect(await cached()).toBeNull();
    expect(await getCachedCompatibility(structuredClone({ ...viewer, showAdult: false }), structuredClone({ ...target, aiUseAdult: true }))).toBeNull();
  });
  it("uses live viewer consent rather than a stale profile argument", async () => {
    viewer.isAdult = viewer.showAdult = viewer.aiUseAdult = true;
    target.isAdult = target.aiUseAdult = true;
    const staleViewer = structuredClone(viewer);
    shelves.get("target")![0].isAdult = true;
    await generate();
    viewer.showAdult = false;
    expect(await getCachedCompatibility(staleViewer, target)).toBeNull();
  });
  it("never sends adult real titles, URLs, images, or notes to agent tools", async () => {
    viewer.isAdult = viewer.showAdult = true;
    target.isAdult = target.aiUseAdult = true;
    shelves.get("target")![0] = makeItem({ id: "target-item", ownerUid: "target", isAdult: true, title: "秘密の成人向けタイトル", url: "https://private.example/product", imageUrl: "https://private.example/image", note: "秘密のメモ" });
    await generate();
    const agent = mocks.agent.mock.calls[0][0];
    const toolOutputs = agent.tools.map((tool: { name: string; execute: (args: { query: string }) => unknown }) => tool.execute({ query: "" }));
    const text = JSON.stringify(toolOutputs);
    expect(text).not.toContain("秘密の成人向けタイトル");
    expect(text).not.toContain("private.example");
    expect(text).not.toContain("秘密のメモ");
  });
  it("does not return or save analysis withdrawn while the model runs", async () => {
    mocks.runAgentJson.mockImplementationOnce(async () => {
      shelves.set("target", []);
      return output;
    });
    await expect(generate()).rejects.toThrow("棚または同意設定が変わりました");
    expect(mocks.set).not.toHaveBeenCalled();
    expect(await cached()).toBeNull();
  });
  it("rejects withdrawal during the save and never reuses the stale result", async () => {
    mocks.set.mockImplementationOnce(async (id, data) => {
      docs.set(id, data);
      shelves.set("target", []);
    });
    await expect(generate()).rejects.toThrow("棚または同意設定が変わりました");
    expect(await cached()).toBeNull();
  });
});
