import type { NextConfig } from "next";
import { validateFirebaseConfig } from "./src/lib/firebase-config";

validateFirebaseConfig({
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}, process.env.GOOGLE_CLOUD_PROJECT);

const nextConfig: NextConfig = {
  output: "standalone",
  env: { FIREBASE_WEB_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID },
  async headers() {
    return [
      { source: "/:path*", headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
      ] },
      { source: "/go/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
  serverExternalPackages: ["firebase-admin", "@google/adk", "@google/genai", "google-auth-library"],
  experimental: {
    serverActions: { bodySizeLimit: "8mb" },
  },
};

export default nextConfig;
