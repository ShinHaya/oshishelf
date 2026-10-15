import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./session", () => ({ getViewer: vi.fn() }));
vi.mock("./firebase-admin", () => ({
  db: {
    collection: vi.fn(),
  },
}));

import { requireAdminPermission, isAdmin, hasPermission } from "./admin";
import { getViewer } from "./session";
import { db } from "./firebase-admin";
import type { Viewer } from "./session";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Admin Authorization", () => {
  describe("requireAdminPermission", () => {
    it("rejects unauthenticated users", async () => {
      vi.mocked(getViewer).mockResolvedValueOnce(null);

      await expect(requireAdminPermission("view")).rejects.toThrow("Not logged in");
    });

    it("rejects users without a profile", async () => {
      vi.mocked(getViewer).mockResolvedValueOnce({
        uid: "user-1",
        email: "user@example.com",
        name: null,
        profile: null,
      } as Viewer);

      await expect(requireAdminPermission("view")).rejects.toThrow("Profile not set up");
    });

    it("rejects users without admin permissions", async () => {
      vi.mocked(getViewer).mockResolvedValueOnce({
        uid: "user-1",
        email: "user@example.com",
        name: null,
        profile: { uid: "user-1" },
      } as Viewer);

      const mockCollection = {
        get: vi.fn().mockResolvedValueOnce({
          docs: [],
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.collection).mockReturnValueOnce(mockCollection as any);

      await expect(requireAdminPermission("view")).rejects.toThrow("Admin permission required");
    });

    it("allows admin users with correct permission", async () => {
      vi.mocked(getViewer).mockResolvedValueOnce({
        uid: "admin-1",
        email: "admin@example.com",
        name: null,
        profile: { uid: "admin-1" },
      } as Viewer);

      const mockDoc = {
        id: "admin-1",
        data: () => ({
          uid: "admin-1",
          email: "admin@example.com",
          permissions: ["view"],
          grantedAt: Date.now(),
          grantedBy: "system",
        }),
      };

      const mockCollection = {
        get: vi.fn().mockResolvedValueOnce({
          docs: [mockDoc],
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.collection).mockReturnValueOnce(mockCollection as any);

      const result = await requireAdminPermission("view");
      expect(result).toBe("admin-1");
    });

    it("rejects view permission when user only has operate permission", async () => {
      vi.mocked(getViewer).mockResolvedValueOnce({
        uid: "admin-1",
        email: "admin@example.com",
        name: null,
        profile: { uid: "admin-1" },
      } as Viewer);

      const mockDoc = {
        id: "admin-1",
        data: () => ({
          uid: "admin-1",
          email: "admin@example.com",
          permissions: ["operate"],
          grantedAt: Date.now(),
          grantedBy: "system",
        }),
      };

      const mockCollection = {
        get: vi.fn().mockResolvedValueOnce({
          docs: [mockDoc],
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.collection).mockReturnValueOnce(mockCollection as any);

      await expect(requireAdminPermission("view")).rejects.toThrow("Admin permission required");
    });

    it("allows operate permission when user has it", async () => {
      vi.mocked(getViewer).mockResolvedValueOnce({
        uid: "admin-1",
        email: "admin@example.com",
        name: null,
        profile: { uid: "admin-1" },
      } as Viewer);

      const mockDoc = {
        id: "admin-1",
        data: () => ({
          uid: "admin-1",
          email: "admin@example.com",
          permissions: ["operate", "view"],
          grantedAt: Date.now(),
          grantedBy: "system",
        }),
      };

      const mockCollection = {
        get: vi.fn().mockResolvedValueOnce({
          docs: [mockDoc],
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.collection).mockReturnValueOnce(mockCollection as any);

      const result = await requireAdminPermission("operate");
      expect(result).toBe("admin-1");
    });
  });

  describe("isAdmin", () => {
    it("returns true for admin users", async () => {
      const mockDoc = {
        id: "admin-1",
        data: () => ({}),
      };

      const mockCollection = {
        get: vi.fn().mockResolvedValueOnce({
          docs: [mockDoc],
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.collection).mockReturnValueOnce(mockCollection as any);

      const result = await isAdmin("admin-1");
      expect(result).toBe(true);
    });

    it("returns false for non-admin users", async () => {
      const mockCollection = {
        get: vi.fn().mockResolvedValueOnce({
          docs: [],
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.collection).mockReturnValueOnce(mockCollection as any);

      const result = await isAdmin("user-1");
      expect(result).toBe(false);
    });
  });

  describe("hasPermission", () => {
    it("returns true when user has the requested permission", async () => {
      const mockDoc = {
        id: "admin-1",
        data: () => ({
          permissions: ["view", "operate"],
        }),
      };

      const mockCollection = {
        get: vi.fn().mockResolvedValueOnce({
          docs: [mockDoc],
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.collection).mockReturnValueOnce(mockCollection as any);

      const result = await hasPermission("admin-1", "view");
      expect(result).toBe(true);
    });

    it("returns false when user does not have the requested permission", async () => {
      const mockDoc = {
        id: "admin-1",
        data: () => ({
          permissions: ["view"],
        }),
      };

      const mockCollection = {
        get: vi.fn().mockResolvedValueOnce({
          docs: [mockDoc],
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.collection).mockReturnValueOnce(mockCollection as any);

      const result = await hasPermission("admin-1", "operate");
      expect(result).toBe(false);
    });

    it("returns false for non-admin users", async () => {
      const mockCollection = {
        get: vi.fn().mockResolvedValueOnce({
          docs: [],
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.collection).mockReturnValueOnce(mockCollection as any);

      const result = await hasPermission("user-1", "view");
      expect(result).toBe(false);
    });
  });
});
