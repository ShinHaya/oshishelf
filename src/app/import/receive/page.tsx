import type { Metadata } from "next";
import { requireProfile } from "@/lib/session";
import { bookmarkletHref, BOOKMARKLET_VERSION } from "@/lib/bookmarklet";
import { Receiver } from "./receiver";

export const metadata: Metadata = { title: "取り込み中" };

export default async function ReceivePage() {
  await requireProfile();
  return (
    <div className="mx-auto max-w-lg py-8">
      <Receiver bookmarklet={bookmarkletHref(process.env.APP_ORIGIN ?? "http://localhost:3000")} version={BOOKMARKLET_VERSION} />
    </div>
  );
}
