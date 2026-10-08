import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), doc: vi.fn((id: string) => ({ id })),
  getAll: vi.fn(), batchUpdate: vi.fn(), commit: vi.fn(), where: vi.fn(), queryGet: vi.fn(),
}));
vi.mock("../firebase-admin", () => ({
  db: {
    collection: () => ({ doc: mocks.doc, where: mocks.where }),
    runTransaction: (fn: (tx: unknown) => Promise<void>) => fn({ get: mocks.get, update: mocks.update }),
    getAll: mocks.getAll,
    batch: () => ({ update: mocks.batchUpdate, commit: mocks.commit }),
  },
}));
vi.mock("./reviews", () => ({ deleteReactionsForItems: vi.fn() }));
import { clearShelfCategory, setItemsShelfCategory, toItem, updateItem } from "./items";

beforeEach(() => { vi.clearAllMocks(); });

describe("item storage", () => {
  it("reads old items without a custom category", () => {
    expect(toItem("fictional-item", {}).shelfCategory).toBeNull();
    expect(toItem("fictional-item", { shelfCategory: "積読" }).shelfCategory).toBe("積読");
  });

  it("checks ownership inside the write transaction", async () => {
    mocks.get.mockResolvedValue({ exists: true, get: () => "other-owner" });
    await expect(updateItem("fictional-owner", "fictional-item", { visibility: "private" })).rejects.toThrow("not found");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a missing item", async () => {
    mocks.get.mockResolvedValue({ exists: false });
    await expect(updateItem("fictional-owner", "missing-item", { visibility: "private" })).rejects.toThrow("not found");
    expect(mocks.update).not.toHaveBeenCalled();
  });

});

describe("bulk shelf category assignment", () => {
  const snap = (id: string, ownerUid: string) => ({ id, exists: true, data: () => ({ ownerUid, url: "https://example.com/p", title: "架空の作品" }) });

  it("puts only the owner's selected items into the category", async () => {
    mocks.getAll.mockResolvedValue([snap("mine-1", "fictional-owner"), snap("theirs", "other-owner"), snap("mine-2", "fictional-owner")]);
    expect(await setItemsShelfCategory("fictional-owner", ["mine-1", "theirs", "mine-2"], "積読")).toBe(2);
    expect(mocks.batchUpdate.mock.calls).toEqual([[{ id: "mine-1" }, { shelfCategory: "積読" }], [{ id: "mine-2" }, { shelfCategory: "積読" }]]);
  });

  it("clears a deleted category only on the owner's items", async () => {
    const query = { where: mocks.where, select: () => ({ get: mocks.queryGet }) };
    mocks.where.mockReturnValue(query);
    mocks.queryGet.mockResolvedValue({ docs: [{ ref: "item-ref-1" }, { ref: "item-ref-2" }] });
    expect(await clearShelfCategory("fictional-owner", "積読")).toBe(2);
    expect(mocks.where.mock.calls).toEqual([["ownerUid", "==", "fictional-owner"], ["shelfCategory", "==", "積読"]]);
    expect(mocks.batchUpdate.mock.calls).toEqual([["item-ref-1", { shelfCategory: null }], ["item-ref-2", { shelfCategory: null }]]);
  });
});
