import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ user: vi.fn(), items: vi.fn(), update: vi.fn(), where: vi.fn() }));
vi.mock("../firebase-admin", () => ({ db: { collection: (name: string) => name === "users" ? { doc: () => ({ get: m.user, update: m.update }) } : { where: m.where } } }));
import { getImportedShops } from "./users";
beforeEach(() => {
  vi.clearAllMocks();
  m.where.mockReturnValue({ select: () => ({ get: m.items }) });
});
it("backfills private history from all statuses and retains recorded shops", async () => {
  m.user.mockResolvedValue({ get: (key: string) => key === "importedShops" ? ["amazon"] : false });
  m.items.mockResolvedValue({ docs: [{ get: () => "dlsite" }, { get: () => "dlsite" }] });
  expect(await getImportedShops("fictional")).toEqual(["amazon", "dlsite"]);
  expect(m.where).toHaveBeenCalledWith("ownerUid", "==", "fictional");
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ importedShopsBackfilled: true, importedShops: expect.anything() }));
});
it("does not rescan items after backfill, retaining shops after item deletion", async () => {
  m.user.mockResolvedValue({ get: (key: string) => key === "importedShopsBackfilled" ? true : ["amazon"] });
  expect(await getImportedShops("fictional")).toEqual(["amazon"]);
  expect(m.items).not.toHaveBeenCalled();
});
