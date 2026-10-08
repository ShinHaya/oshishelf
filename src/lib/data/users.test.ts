import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), doc: vi.fn((id: string) => ({ id })) }));
vi.mock("../firebase-admin", () => ({
  db: {
    collection: () => ({ doc: mocks.doc }),
    runTransaction: (fn: (tx: unknown) => Promise<void>) => fn({ get: mocks.get, update: mocks.update }),
  },
}));
import { addShelfCategory, MAX_SHELF_CATEGORIES } from "./users";

const userWith = (shelfCategories?: string[]) => ({ get: (field: string) => (field === "shelfCategories" ? shelfCategories : undefined) });

beforeEach(() => { vi.clearAllMocks(); });

describe("shelf category list", () => {
  it("adds a new category to the owner's list", async () => {
    mocks.get.mockResolvedValue(userWith());
    await addShelfCategory("fictional-owner", "積読");
    expect(mocks.doc).toHaveBeenCalledWith("fictional-owner");
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("does not write an existing category again, even at the limit", async () => {
    const full = Array.from({ length: MAX_SHELF_CATEGORIES }, (_, i) => `架空${i}`);
    mocks.get.mockResolvedValue(userWith(full));
    await addShelfCategory("fictional-owner", "架空0");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a new category beyond the limit", async () => {
    mocks.get.mockResolvedValue(userWith(Array.from({ length: MAX_SHELF_CATEGORIES }, (_, i) => `架空${i}`)));
    await expect(addShelfCategory("fictional-owner", "新しいカテゴリー")).rejects.toThrow(`${MAX_SHELF_CATEGORIES}個まで`);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
