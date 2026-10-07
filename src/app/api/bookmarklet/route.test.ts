import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { bookmarkletScript } from "@/lib/bookmarklet";

afterEach(() => { vi.unstubAllEnvs(); });

describe("public current bookmarklet distribution", () => {
  it("serves current code with no cache, cross-origin loading, and no authentication", async () => {
    vi.stubEnv("APP_ORIGIN", "https://shelf.example");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(await response.text()).toBe(bookmarkletScript("https://shelf.example"));
  });

  it("uses only the configured app origin", async () => {
    vi.stubEnv("APP_ORIGIN", "https://shelf.example/import");
    const script = await (await GET()).text();
    expect(script).toContain('"https://shelf.example"');
    expect(() => new Function(script)).not.toThrow();
  });
});
