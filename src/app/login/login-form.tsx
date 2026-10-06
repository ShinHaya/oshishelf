"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createUserWithEmailAndPassword, GoogleAuthProvider, signInWithEmailAndPassword, signInWithPopup, signOut, type UserCredential } from "firebase/auth";
import { clientAuth } from "@/lib/firebase-client";

const DEMO = { email: "demo@oshishelf.app", password: "oshishelf-demo-2026" };

const ERRORS: Record<string, string> = {
  "auth/invalid-credential": "メールアドレスまたはパスワードが違います",
  "auth/email-already-in-use": "このメールアドレスは登録済みです",
  "auth/weak-password": "パスワードは6文字以上にしてください",
  "auth/invalid-email": "メールアドレスの形式が正しくありません",
  "auth/too-many-requests": "試行回数が多すぎます。しばらく待ってからお試しください",
  "auth/popup-blocked": "ポップアップがブロックされました。ブラウザの設定で許可してください",
  "auth/popup-closed-by-user": "ログインがキャンセルされました",
  "auth/cancelled-popup-request": "ログインがキャンセルされました",
  "auth/operation-not-allowed": "このログイン方法は現在利用できません",
  "auth/unauthorized-domain": "このドメインからのログインは許可されていません",
  "auth/account-exists-with-different-credential": "このメールアドレスは別の方法で登録済みです。メールアドレスでログインしてください",
};

function googleProvider() {
  const provider = new GoogleAuthProvider();
  // Always show the account chooser so people can pick which Google account to use.
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

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

  async function run(signIn: () => Promise<UserCredential>) {
    setBusy(true);
    setError(null);
    try {
      const cred = await signIn();
      await finish(await cred.user.getIdToken());
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setError(ERRORS[code] ?? "ログインに失敗しました");
      setBusy(false);
    }
  }

  const submit = (creds: { email: string; password: string }, m: "login" | "signup") =>
    run(() => (m === "signup" ? createUserWithEmailAndPassword(clientAuth, creds.email, creds.password) : signInWithEmailAndPassword(clientAuth, creds.email, creds.password)));

  return (
    <div className="card p-6">
      <h1 className="font-display text-2xl font-bold">{mode === "signup" ? "推し棚をはじめる" : "おかえりなさい"}</h1>
      <p className="mt-1 text-sm text-ink-2">買ったものの棚を、同じ趣味の仲間と見せ合おう。</p>
      <button type="button" className="btn-ghost mt-5 w-full !py-2.5" disabled={busy} onClick={() => run(() => signInWithPopup(clientAuth, googleProvider()))}>
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
          <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
          <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
          <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
        </svg>
        Googleで{mode === "signup" ? "はじめる" : "ログイン"}
      </button>
      <div className="my-4 flex items-center gap-3 text-xs text-ink-2">
        <span className="h-px flex-1 bg-line" />
        またはメールアドレスで
        <span className="h-px flex-1 bg-line" />
      </div>
      <form
        className="space-y-3"
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
