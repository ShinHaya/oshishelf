import { bookmarkletScript } from "@/lib/bookmarklet";

// This endpoint contains only public code; it never reads a session, history or database.
export async function GET() {
  return new Response(bookmarkletScript(process.env.APP_ORIGIN ?? "http://localhost:3000"), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
