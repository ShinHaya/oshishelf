import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
const auth = vi.hoisted(() => ({ verifySessionCookie: vi.fn(), revokeRefreshTokens: vi.fn(), verifyIdToken: vi.fn(), createSessionCookie: vi.fn() }));
vi.mock("@/lib/firebase-admin", () => ({ adminAuth: auth }));
vi.mock("@/lib/session", () => ({ SESSION_COOKIE: "__session", SESSION_MAX_AGE_MS: 432000000 }));
import { DELETE, POST } from "./route";
const req = (origin: string | null = "https://app.example", token = "fictional-cookie", method = "DELETE", body?: string) => new NextRequest("https://app.example/api/session", {
  method, headers: { ...(origin === null ? {} : { origin }), ...(token ? { cookie: `__session=${token}` } : {}), "content-type": "application/json" }, body,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_ORIGIN", "https://app.example");
  auth.verifySessionCookie.mockResolvedValue({ uid: "fictional-user" });
  auth.revokeRefreshTokens.mockResolvedValue(undefined);
});
describe("session logout", () => {
  it("verifies the caller and revokes all account sessions before deleting the cookie", async () => {
    const res = await DELETE(req());
    expect(res.status).toBe(200);
    expect(auth.verifySessionCookie).toHaveBeenCalledWith("fictional-cookie", true);
    expect(auth.revokeRefreshTokens).toHaveBeenCalledWith("fictional-user");
    expect(res.headers.get("set-cookie")).toContain("__session=;");
    expect(auth.verifySessionCookie.mock.invocationCallOrder[0]).toBeLessThan(auth.revokeRefreshTokens.mock.invocationCallOrder[0]);
  });
  it.each([null, "null", "invalid", "https://evil.example", "http://app.example", "https://app.example:8443", "https://app.example/path"])("rejects both session mutations from origin %s", async (origin) => {
    expect((await DELETE(req(origin))).status).toBe(403);
    expect((await POST(req(origin, "", "POST", '{"idToken":"fictional"}'))).status).toBe(403);
    expect(auth.verifySessionCookie).not.toHaveBeenCalled();
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
    expect(auth.revokeRefreshTokens).not.toHaveBeenCalled();
  });
  it("does not revoke an unverified token", async () => {
    auth.verifySessionCookie.mockRejectedValueOnce(Object.assign(new Error("bad cookie"), { code: "auth/invalid-session-cookie" }));
    const res = await DELETE(req());
    expect(res.status).toBe(200);
    expect(auth.revokeRefreshTokens).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toContain("__session=;");
  });
  it("handles missing and already revoked cookies", async () => {
    expect((await DELETE(req("https://app.example", ""))).status).toBe(200);
    auth.verifySessionCookie.mockRejectedValueOnce(Object.assign(new Error("revoked"), { code: "auth/session-cookie-revoked" }));
    expect((await DELETE(req())).status).toBe(200);
    expect(auth.revokeRefreshTokens).not.toHaveBeenCalled();
  });
  it("reports revocation outages without falsely completing logout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.revokeRefreshTokens.mockRejectedValueOnce(new Error("internal Firebase project"));
    const res = await DELETE(req());
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).not.toContain("internal Firebase project");
  });
  it.each(["null", "{}", '{"idToken":123}', "not JSON"])("rejects malformed sign-in bodies %s", async (body) => {
    expect((await POST(req("https://app.example", "", "POST", body))).status).toBe(400);
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
  });
  it("still creates a secure cookie for a fresh, verified sign-in", async () => {
    auth.verifyIdToken.mockResolvedValueOnce({ uid: "fictional-user", auth_time: Date.now() / 1000, email_verified: true, firebase: { sign_in_provider: "password" } });
    auth.createSessionCookie.mockResolvedValueOnce("fictional-new-cookie");
    const res = await POST(req("https://app.example", "", "POST", '{"idToken":"fictional-id-token"}'));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("SameSite=lax");
  });
});
