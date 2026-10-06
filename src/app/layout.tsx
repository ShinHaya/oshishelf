import type { Metadata, Viewport } from "next";
import { Header } from "@/components/header";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "推し棚 OshiShelf", template: "%s | 推し棚" },
  description: "買ったものの「棚」を公開して、同じ趣味のファンと繋がるSNS。AIエージェントがあなたの嗜好を読み解きます。",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Zen+Maru+Gothic:wght@500;700&display=swap" rel="stylesheet" />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        <Header />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-4">{children}</main>
        <footer className="border-t border-line py-6 text-center text-xs text-ink-2">
          推し棚 OshiShelf — 第5回 Agentic AI Hackathon with Google Cloud 応募作品
        </footer>
      </body>
    </html>
  );
}
