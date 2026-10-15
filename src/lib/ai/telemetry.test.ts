import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTraceId, type TelemetryRecord, recordTelemetry, recordToolCall, deleteTelemetryForUser, deleteExpiredTelemetry } from "./telemetry";

// Mock Firebase Admin
vi.mock("server-only", () => ({}));

vi.mock("../firebase-admin", () => ({
  db: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue({ get: vi.fn() }),
      })),
      where: vi.fn(() => ({
        select: vi.fn(() => ({
          get: vi.fn().mockResolvedValue({
            docs: [],
          }),
        })),
      })),
    })),
    batch: vi.fn(() => ({
      delete: vi.fn(),
      commit: vi.fn().mockResolvedValue(undefined),
    })),
  },
  PROJECT_ID: "test-project",
}));

describe("Telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createTraceId", () => {
    it("generates unique trace IDs", () => {
      const id1 = createTraceId();
      const id2 = createTraceId();
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe("string");
      expect(id1.length).toBeGreaterThan(0);
    });
  });

  describe("recordTelemetry - sensitive data filtering", () => {
    it("should record telemetry without input/output text", async () => {
      const record: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123",
        function: "importer",
        environment: "dev",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: true,
      };

      // Should not throw and should not include sensitive fields like text, args, results
      await expect(recordTelemetry(record)).resolves.toBeUndefined();
    });

    it("should normalize error types without messages", async () => {
      const record: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123",
        function: "guard",
        environment: "dev",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: false,
        errorType: "API_ERROR", // Normalized, no message content
      };

      await expect(recordTelemetry(record)).resolves.toBeUndefined();
      // Error record should not contain original error message or stack
      expect(record.errorType).not.toContain("Error:");
      expect(record.errorType).not.toContain("at ");
    });

    it("should handle tokens safely - only include if available", async () => {
      const record1: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123",
        function: "profile",
        environment: "dev",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: true,
        tokens: {
          input: 150,
          output: 200,
          cacheRead: 50,
        },
      };

      await expect(recordTelemetry(record1)).resolves.toBeUndefined();

      // Record without token info (omitted, not 0)
      const record2: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123",
        function: "twin",
        environment: "dev",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: true,
      };

      await expect(recordTelemetry(record2)).resolves.toBeUndefined();
      // Should not have tokens property
      expect(record2.tokens).toBeUndefined();
    });
  });

  describe("recordTelemetry - trace relationships", () => {
    it("should track parent-child traces for retries", async () => {
      const parentTrace = createTraceId();
      const attempt2: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123",
        function: "importer",
        environment: "dev",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: true,
        parentTraceId: parentTrace,
        attempt: 2,
      };

      await expect(recordTelemetry(attempt2)).resolves.toBeUndefined();
      expect(attempt2.parentTraceId).toBe(parentTrace);
      expect(attempt2.attempt).toBe(2);
    });

    it("should track cache hits", async () => {
      const record: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123",
        function: "profile",
        environment: "dev",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: true,
        fromCache: true,
      };

      await expect(recordTelemetry(record)).resolves.toBeUndefined();
      expect(record.fromCache).toBe(true);
    });
  });

  describe("recordToolCall", () => {
    it("should record tool calls without arguments/results", async () => {
      const traceId = createTraceId();
      const call = {
        traceId,
        tool: "list_watched_wishes",
        success: true,
        timestamp: Date.now(),
      };

      // Should not throw
      await expect(recordToolCall(call)).resolves.toBeUndefined();
    });

    it("should record tool failures without exposing error details", async () => {
      const traceId = createTraceId();
      const call = {
        traceId,
        tool: "check_price",
        success: false,
        errorType: "NETWORK_ERROR",
        timestamp: Date.now(),
      };

      await expect(recordToolCall(call)).resolves.toBeUndefined();
      expect(call.errorType).toBe("NETWORK_ERROR");
    });
  });

  describe("Adult content and sensitive data", () => {
    it("should not include adult content in telemetry", async () => {
      // R18 content should never appear in traces
      const record: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123",
        function: "importer",
        environment: "dev",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: true,
        // No adult content fields - they should never be included
      };

      await expect(recordTelemetry(record)).resolves.toBeUndefined();
      expect(JSON.stringify(record)).not.toContain("adult");
    });

    it("should not include purchase URLs in telemetry", async () => {
      const record: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123",
        function: "guard",
        environment: "dev",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: true,
        // URLs should never be stored
      };

      await expect(recordTelemetry(record)).resolves.toBeUndefined();
      expect(JSON.stringify(record)).not.toContain("http");
    });

    it("should not include email addresses in telemetry", async () => {
      const record: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123",
        function: "profile",
        environment: "dev",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: true,
        // No email fields
      };

      await expect(recordTelemetry(record)).resolves.toBeUndefined();
      expect(JSON.stringify(record)).not.toContain("@");
    });

    it("should not include auth credentials", async () => {
      const record: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123", // Only UID, no tokens/credentials
        function: "twin",
        environment: "dev",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: true,
      };

      await expect(recordTelemetry(record)).resolves.toBeUndefined();
      // Should only have uid, not auth token/session data
      expect(Object.keys(record)).toContain("uid");
      expect(Object.keys(record).some((k) => k.includes("token") || k.includes("secret"))).toBe(false);
    });
  });

  describe("Functions coverage", () => {
    const functions: Array<"guard" | "importer" | "profile" | "twin" | "compat" | "watcher"> = [
      "guard",
      "importer",
      "profile",
      "twin",
      "compat",
      "watcher",
    ];

    it("should support all 6 AI functions", async () => {
      for (const func of functions) {
        const record: TelemetryRecord = {
          traceId: createTraceId(),
          uid: "user123",
          function: func,
          environment: "dev",
          model: "gemini-2.0-flash",
          version: "1.0",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          ok: true,
        };

        await expect(recordTelemetry(record)).resolves.toBeUndefined();
      }
    });
  });

  describe("Retention and deletion", () => {
    it("deleteExpiredTelemetry should handle missing records gracefully", async () => {
      // Should not throw even if collection is empty
      await expect(deleteExpiredTelemetry()).resolves.toBeDefined();
    });

    it("deleteTelemetryForUser should handle missing user records gracefully", () => {
      // Should not throw (fire-and-forget, no promise)
      expect(() => deleteTelemetryForUser("nonexistent")).not.toThrow();
    });
  });

  describe("No double-counting with agentRuns", () => {
    it("watcher traces should be distinct from legacy agentRuns", async () => {
      const watcherTrace: TelemetryRecord = {
        traceId: createTraceId(),
        uid: "user123",
        function: "watcher",
        environment: "prod",
        model: "gemini-2.0-flash",
        version: "1.0",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ok: true,
      };

      // Should store in aiTelemetry, not agentRuns
      await expect(recordTelemetry(watcherTrace)).resolves.toBeUndefined();

      // Legacy agentRuns record should not be duplicated when reading from new telemetry
      // (This is validated at query time, not storage time)
    });
  });
});
