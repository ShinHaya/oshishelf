import { describe, expect, it } from "vitest";
import config from "../../next.config";

describe("browser security headers", () => {
  it("enforces frame isolation and response protections across the application", async () => {
    const rules = await config.headers!();
    const all = rules.find((r) => r.source === "/:path*")!.headers;
    const headers = Object.fromEntries(all.map((h) => [h.key, h.value]));
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000");
    expect(rules.find((r) => r.source === "/go/:path*")!.headers).toContainEqual({ key: "Cache-Control", value: "no-store" });
  });
});
