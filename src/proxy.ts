import { NextResponse, type NextRequest } from "next/server";

/**
 * Canonical host: www.oshi-dana.com and the raw *.run.app URL redirect to APP_ORIGIN.
 * API routes are left alone so Cloud Scheduler can keep calling the run.app URL directly.
 */
export function proxy(request: NextRequest) {
  const appOrigin = process.env.APP_ORIGIN;
  const host = request.headers.get("host") ?? "";
  if (!appOrigin || host === new URL(appOrigin).host) return NextResponse.next();
  if (host.startsWith("www.") || host.endsWith(".run.app")) {
    const target = new URL(request.nextUrl.pathname + request.nextUrl.search, appOrigin);
    return NextResponse.redirect(target, 301);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon.ico).*)"],
};
