import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/session";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "プロフィール作成" };

export default async function OnboardingPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.profile) redirect("/");
  return (
    <div className="mx-auto max-w-md py-10">
      <OnboardingForm defaultName={viewer.name ?? ""} />
    </div>
  );
}
