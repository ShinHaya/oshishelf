"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { clientAuth } from "@/lib/firebase-client";

const DEMO = { email: "demo@oshishelf.app", password: "oshishelf-demo-2026" };

const ERRORS: Record<string, string> = {
  "auth/invalid-credential": "メールアドレスまたはパスワードが違います",
  "auth/email-already-in-use": "このメールアドレスは登録済みです",
  "auth/weak-password": "パスワードは6文字以上にしてください",
  "auth/invalid-email": "メールアドレスの形式が正しくありません",
  "auth/too-many-requests": "試行回数が多すぎます。しばらく待ってからお試しください",
};

export function LoginForm({ initialMode }: { initialMode: "login" | "signup" }) {
  const router = useRouter();
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function finish(idToken: string) {
    const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }) });
    // The session cookie is the only credential the server trusts; drop the client SDK session.
    await signOut(clientAuth);
    if (!res.ok) throw new Error("session");
    router.replace("/");
    router.refresh();
  }

  async function submit(creds: { email: string; password: string }, m: "login" | "signup") {
    setBusy(true);
    setError(null);
    try {
      const cred = m === "signup" ? await createUserWithEmailAndPassword(clientAuth, creds.email, creds.password) : await signInWithEmailAndPassword(clientAuth, creds.email, creds.password);
      await finish(await cred.user.getIdToken());
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setError(ERRORS[code] ?? "ログインに失敗しました");
      setBusy(false);
    }
  }

  return (
    <div className="card p-6">
      <h1 className="font-display text-2xl font-bold">{mode === "signup" ? "推し棚をはじめる" : "おかえりなさい"}</h1>
      <p className="mt-1 text-sm text-ink-2">買ったものの棚を、同じ趣味の仲間と見せ合おう。</p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit({ email, password }, mode);
        }}
      >
        <label className="block text-sm">
          メールアドレス
          <input className="input mt-1" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block text-sm">
          パスワード
          <input
            className="input mt-1"
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            minLength={6}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "処理中…" : mode === "signup" ? "アカウント作成" : "ログイン"}
        </button>
      </form>
      <button type="button" className="mt-3 w-full text-center text-sm text-ink-2 underline" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>
        {mode === "signup" ? "アカウントをお持ちの方はログイン" : "はじめての方はアカウント作成"}
      </button>
      <div className="mt-6 rounded-xl bg-accent-soft p-4 text-sm">
        <p className="font-bold">審査員・お試しの方へ</p>
        <p className="mt-1 text-ink-2">サンプルデータ入りのデモアカウントで全機能を試せます。</p>
        <button type="button" className="btn-primary mt-3 w-full" disabled={busy} onClick={() => submit(DEMO, "login")}>
          デモアカウントでログイン
        </button>
      </div>
    </div>
  );
}
