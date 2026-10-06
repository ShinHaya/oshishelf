import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "ログイン" };

export default async function LoginPage(props: PageProps<"/login">) {
  const viewer = await getViewer();
  if (viewer) redirect(viewer.profile ? "/" : "/onboarding");
  const { mode, verified, reset } = await props.searchParams;
  // Firebase's email action pages send people back here after verifying / resetting.
  const notice = verified ? "メールアドレスを確認しました。ログインしてください。" : reset ? "パスワードを再設定しました。新しいパスワードでログインしてください。" : null;
  return (
    <div className="mx-auto max-w-sm py-10">
      <LoginForm initialMode={mode === "signup" ? "signup" : "login"} notice={notice} />
    </div>
  );
}
