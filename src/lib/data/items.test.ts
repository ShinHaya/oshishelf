import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), doc: vi.fn((id: string) => ({ id })),
}));
vi.mock("../firebase-admin", () => ({
  db: {
    collection: () => ({ doc: mocks.doc }),
    runTransaction: (fn: (tx: unknown) => Promise<void>) => fn({ get: mocks.get, update: mocks.update }),
  },
}));
vi.mock("./reviews", () => ({ deleteReactionsForItems: vi.fn() }));
import { toItem, updateItem } from "./items";

beforeEach(() => { vi.clearAllMocks(); });

describe("shelf category storage", () => {
  it("reads old items without a custom category", () => {
    expect(toItem("fictional-item", {}).shelfCategory).toBeNull();
    expect(toItem("fictional-item", { shelfCategory: "積読" }).shelfCategory).toBe("積読");
  });

  it("checks ownership inside the write transaction", async () => {
    mocks.get.mockResolvedValue({ exists: true, get: () => "other-owner" });
    await expect(updateItem("fictional-owner", "fictional-item", { shelfCategory: "積読" })).rejects.toThrow("not found");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a missing item", async () => {
    mocks.get.mockResolvedValue({ exists: false });
    await expect(updateItem("fictional-owner", "missing-item", { shelfCategory: null })).rejects.toThrow("not found");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("updates only the category for its owner", async () => {
    mocks.get.mockResolvedValue({ exists: true, get: () => "fictional-owner" });
    await updateItem("fictional-owner", "fictional-item", { shelfCategory: "積読" });
    expect(mocks.update).toHaveBeenCalledWith({ id: "fictional-item" }, { shelfCategory: "積読" });
  });
});
