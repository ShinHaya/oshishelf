import type { Metadata } from "next";
import { requireProfile } from "@/lib/session";
import { SettingsForm } from "./settings-form";
import { BioGenerator } from "./bio-generator";
import { LogoutButton } from "./logout-button";

export const metadata: Metadata = { title: "設定" };

export default async function SettingsPage() {
  const { profile } = await requireProfile();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="font-display text-2xl font-bold">設定</h1>
      <BioGenerator current={profile.aiBio} draft={profile.aiBioDraft} />
      <SettingsForm profile={profile} />
      <LogoutButton />
    </div>
  );
}
