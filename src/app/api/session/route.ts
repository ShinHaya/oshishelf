import { NextResponse, type NextRequest } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS } from "@/lib/session";

/** Exchange a fresh Firebase ID token for an httpOnly session cookie. */
export async function POST(req: NextRequest) {
  // Same-origin only (CSRF protection for the cookie-setting endpoint).
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { idToken } = (await req.json().catch(() => ({}))) as { idToken?: string };
  if (!idToken) return NextResponse.json({ error: "missing token" }, { status: 400 });
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

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
