import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), transaction: vi.fn() }));
vi.mock("../firebase-admin", () => ({
  adminAuth: { getUser: mocks.getUser },
  db: { collection: (collection: string) => ({ doc: (id: string) => `${collection}/${id}` }), runTransaction: mocks.transaction },
}));
vi.mock("./items", () => ({}));
import { consumeQuota, DAILY_LIMITS, GLOBAL_DAILY_LIMITS } from "./social";

let userUsed: number;
let globalUsed: number;
const set = vi.fn();
beforeEach(() => {
  userUsed = 0;
  globalUsed = 0;
  set.mockReset();
  mocks.getUser.mockResolvedValue({ metadata: { creationTime: "2020-01-01T00:00:00Z" } });
  mocks.transaction.mockImplementation(async (fn) => fn({
    get: async (ref: string) => ({ get: () => ref.startsWith("globalUsage/") ? globalUsed : userUsed }),
    set,
  }));
});

describe("atomic daily reservations", () => {
  it("accepts the exact user limit and updates both counters", async () => {
    userUsed = DAILY_LIMITS.import - 30;
    await consumeQuota("fictional-owner", "import", 30);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[0][1]).toMatchObject({ import: 300, uid: "fictional-owner" });
    expect(set.mock.calls[1][1]).toMatchObject({ import: 30 });
    expect(set.mock.calls[1][1]).not.toHaveProperty("uid");
  });
  it("rejects a batch that would exceed the user limit without changing either counter", async () => {
    userUsed = DAILY_LIMITS.import - 29;
    await expect(consumeQuota("fictional-owner", "import", 30)).rejects.toThrow("本日のAI利用上限");
    expect(set).not.toHaveBeenCalled();
  });
  it("accepts the exact global limit and rejects another user's request beyond it", async () => {
    globalUsed = GLOBAL_DAILY_LIMITS.import - 30;
    await consumeQuota("fictional-a", "import", 30);
    globalUsed = GLOBAL_DAILY_LIMITS.import;
    set.mockClear();
    await expect(consumeQuota("fictional-b", "import")).rejects.toThrow("サービス全体");
    expect(set).not.toHaveBeenCalled();
  });
  it("restricts accounts younger than seven days, using Auth creation time", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    mocks.getUser.mockResolvedValue({ metadata: { creationTime: new Date(now - 7 * 86400000 + 1).toISOString() } });
    await consumeQuota("fictional-new", "import", 50);
    await expect(consumeQuota("fictional-new", "import", 51)).rejects.toThrow("本日のAI利用上限");
    mocks.getUser.mockResolvedValue({ metadata: { creationTime: new Date(now - 7 * 86400000).toISOString() } });
    await consumeQuota("fictional-new", "import", 150);
  });
  it("uses new documents at the UTC day boundary", async () => {
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(Date.parse("2026-10-14T23:59:59Z"));
    await consumeQuota("fictional-owner", "bio");
    expect(set.mock.calls[0][0]).toBe("usage/fictional-owner_2026-10-14");
    expect(set.mock.calls[1][0]).toBe("globalUsage/2026-10-14");
    set.mockClear();
    clock.mockReturnValue(Date.parse("2026-10-15T00:00:00Z"));
    await consumeQuota("fictional-owner", "bio");
    expect(set.mock.calls[0][0]).toBe("usage/fictional-owner_2026-10-15");
    expect(set.mock.calls[1][0]).toBe("globalUsage/2026-10-15");
  });
  it("rechecks fresh counters when a conflicting transaction is retried", async () => {
    mocks.transaction.mockImplementationOnce(async (fn) => {
      const tx = { get: async (ref: string) => ({ get: () => ref.startsWith("globalUsage/") ? globalUsed : userUsed }), set };
      await fn(tx); // First attempt is discarded by Firestore on conflict.
      set.mockClear();
      userUsed = DAILY_LIMITS.import;
      return fn(tx);
    });
    await expect(consumeQuota("fictional-owner", "import", 30)).rejects.toThrow("本日のAI利用上限");
    expect(set).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid units %s before accessing storage", async (units) => {
    await expect(consumeQuota("fictional-owner", "import", units)).rejects.toThrow("利用量");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("keeps the existing single-unit limits for other AI features", async () => {
    userUsed = DAILY_LIMITS.bio;
    await expect(consumeQuota("fictional-owner", "bio")).rejects.toThrow("本日のAI利用上限");
    expect(set).not.toHaveBeenCalled();
  });
});
