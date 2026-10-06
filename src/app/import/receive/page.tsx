import type { Metadata } from "next";
import { requireProfile } from "@/lib/session";
import { Receiver } from "./receiver";

export const metadata: Metadata = { title: "取り込み中" };

export default async function ReceivePage() {
  await requireProfile();
  return (
    <div className="mx-auto max-w-lg py-8">
      <Receiver />
    </div>
  );
}
