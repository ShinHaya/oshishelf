import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminAuth } from "./firebase-admin";
import { getUser } from "./data/users";
import type { UserProfile } from "./types";

export const SESSION_COOKIE = "__session";
export const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 5;

export interface Viewer {
  uid: string;
  email: string | null;
  profile: UserProfile | null;
}

/** Resolve the signed-in user from the httpOnly session cookie (memoized per request). */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const decoded = await adminAuth.verifySessionCookie(token, true);
    const profile = await getUser(decoded.uid);
    return { uid: decoded.uid, email: decoded.email ?? null, profile };
  } catch {
    return null;
  }
});

/** For pages/actions that need a fully onboarded user. */
export async function requireProfile(): Promise<Viewer & { profile: UserProfile }> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (!viewer.profile) redirect("/onboarding");
  return viewer as Viewer & { profile: UserProfile };
}
