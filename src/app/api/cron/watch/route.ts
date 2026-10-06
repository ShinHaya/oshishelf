import { NextResponse, type NextRequest } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { listWatchingUserIds } from "@/lib/data/social";
import { runWatcherFor } from "@/lib/ai/agents/watcher";

export const maxDuration = 300;

const oauth = new OAuth2Client();

/** Only Cloud Scheduler's service account (OIDC token with our audience) may trigger patrols. */
async function authorized(req: NextRequest): Promise<boolean> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const expectedEmail = process.env.SCHEDULER_SA_EMAIL;
  // The scheduler calls the run.app URL directly, so its audience can differ from APP_ORIGIN.
  const audience = process.env.CRON_AUDIENCE ?? `${process.env.APP_ORIGIN}/api/cron/watch`;
  if (!token || !expectedEmail) return false;
  try {
    const ticket = await oauth.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    return payload?.email === expectedEmail && payload.email_verified === true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const uids = await listWatchingUserIds(30);
  const results: { uid: string; ok: boolean }[] = [];
  for (const uid of uids) {
    try {
      await runWatcherFor(uid);
      results.push({ uid, ok: true });
    } catch (e) {
      console.error("watcher", uid, e);
      results.push({ uid, ok: false });
    }
  }
  return NextResponse.json({ ran: results.length, failed: results.filter((r) => !r.ok).length });
}
