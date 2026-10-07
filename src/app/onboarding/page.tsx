import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/session";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "プロフィール作成" };

export default async function OnboardingPage(props: PageProps<"/onboarding">) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.profile) redirect("/");
  // Suggested handle (e.g. the X username after signing in with X); only offered if it already fits the handle rules.
  const { handle } = await props.searchParams;
  const suggested = typeof handle === "string" ? handle.toLowerCase() : "";
  return (
    <div className="mx-auto max-w-md py-10">
      <OnboardingForm defaultName={viewer.name ?? ""} defaultHandle={/^[a-z0-9_]{3,20}$/.test(suggested) ? suggested : ""} />
    </div>
  );
}
