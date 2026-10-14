import { NextResponse, type NextRequest } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS } from "@/lib/session";

/** Exchange a fresh Firebase ID token for an httpOnly session cookie. */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const idToken = body && typeof body === "object" ? body.idToken : null;
  if (typeof idToken !== "string" || !idToken) return NextResponse.json({ error: "missing token" }, { status: 400 });
  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    // Require a recent sign-in to mint a session.
    if (Date.now() / 1000 - decoded.auth_time > 5 * 60) return NextResponse.json({ error: "stale login" }, { status: 401 });
    // Email/password accounts must verify their address before getting a session.
    if (decoded.firebase.sign_in_provider === "password" && !decoded.email_verified) {
      return NextResponse.json({ error: "email not verified" }, { status: 403 });
    }
    const cookie = await adminAuth.createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_MS });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_MS / 1000,
    });
    return res;
  } catch (e) {
    console.error("session", e);
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }
}

/** Validate the entire origin, including scheme and port; malformed/missing origins are rejected. */
function sameOrigin(req: NextRequest): boolean {
  try {
    const origin = req.headers.get("origin");
    const allowed = new URL(process.env.APP_ORIGIN ?? req.url).origin;
    return !!origin && new URL(origin).origin === origin && origin === allowed;
  } catch {
    return false;
  }
}

export async function DELETE(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      const decoded = await adminAuth.verifySessionCookie(token, true);
      // Firebase revocation affects all sessions for this account, including other browsers.
      await adminAuth.revokeRefreshTokens(decoded.uid);
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? e.code : null;
      if (!["auth/session-cookie-expired", "auth/session-cookie-revoked", "auth/invalid-session-cookie", "auth/argument-error", "auth/user-disabled", "auth/user-not-found"].includes(String(code))) {
        console.error("logout", e);
        return NextResponse.json({ error: "ログアウトに失敗しました。もう一度お試しください。" }, { status: 503 });
      }
    }
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
