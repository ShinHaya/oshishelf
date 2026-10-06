"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
  type UserCredential,
} from "firebase/auth";
import { clientAuth } from "@/lib/firebase-client";

type Mode = "login" | "signup" | "reset";

const ERRORS: Record<string, string> = {
  "auth/invalid-credential": "メールアドレスまたはパスワードが違います",
  "auth/email-already-in-use": "このメールアドレスは登録済みです。ログインするか、パスワードを再設定してください",
  "auth/weak-password": "パスワードは6文字以上にしてください",
  "auth/invalid-email": "メールアドレスの形式が正しくありません",
  "auth/missing-email": "メールアドレスを入力してください",
  "auth/too-many-requests": "試行回数が多すぎます。しばらく待ってからお試しください",
  "auth/popup-blocked": "ポップアップがブロックされました。ブラウザの設定で許可してください",
  "auth/popup-closed-by-user": "ログインがキャンセルされました",
  "auth/cancelled-popup-request": "ログインがキャンセルされました",
  "auth/operation-not-allowed": "このログイン方法は現在利用できません",
  "auth/unauthorized-domain": "このドメインからのログインは許可されていません",
  "auth/account-exists-with-different-credential": "このメールアドレスは別の方法で登録済みです。メールアドレスでログインしてください",
};

class UnverifiedEmailError extends Error {}

function googleProvider() {
  const provider = new GoogleAuthProvider();
  // Always show the account chooser so people can pick which Google account to use.
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

/** Where Firebase's email action pages send the user back to. */
function continueUrl(flag: string) {
  return { url: `${window.location.origin}/login?${flag}=1` };
}

async function sendVerification(user: User) {
  clientAuth.languageCode = "ja";
  await sendEmailVerification(user, continueUrl("verified"));
}

export function LoginForm({ initialMode, notice: initialNotice }: { initialMode: "login" | "signup"; notice?: string | null }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const [unverified, setUnverified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // Each new reset/verification email invalidates the previous link, so throttle re-sends.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
    setNotice(null);
    setUnverified(false);
    setResetSentTo(null);
  }

  async function finish(user: User) {
    // Password accounts must confirm their email first. Besides proving ownership, a verified
    // email keeps the password sign-in when the same address later signs in with Google.
    const isPassword = user.providerData.some((p) => p.providerId === "password");
    const hasGoogle = user.providerData.some((p) => p.providerId === "google.com");
    if (isPassword && !hasGoogle && !user.emailVerified) {
      await signOut(clientAuth);
      throw new UnverifiedEmailError();
    }
    const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: await user.getIdToken() }) });
    // The session cookie is the only credential the server trusts; drop the client SDK session.
    await signOut(clientAuth);
    if (!res.ok) throw new Error("session");
    router.replace("/");
    router.refresh();
  }

  async function run(signIn: () => Promise<UserCredential>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    setUnverified(false);
    try {
      const cred = await signIn();
      await finish(cred.user);
    } catch (e) {
      if (e instanceof UnverifiedEmailError) {
        setUnverified(true);
        setError("メールアドレスの確認が済んでいません。届いたメールのリンクを開いてから、もう一度ログインしてください。");
      } else {
        const code = (e as { code?: string }).code ?? "";
        setError(ERRORS[code] ?? "ログインに失敗しました");
      }
      setBusy(false);
    }
  }

  async function signup() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const cred = await createUserWithEmailAndPassword(clientAuth, email, password);
      await sendVerification(cred.user);
      await signOut(clientAuth);
      setMode("login");
      setPassword("");
      setCooldown(60);
      setNotice(`${email} に確認メールを送りました。メール内のリンクを開いてから、ログインしてください。`);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setError(ERRORS[code] ?? "登録に失敗しました");
    }
    setBusy(false);
  }

  async function resendVerification() {
    setBusy(true);
    setError(null);
    try {
      const cred = await signInWithEmailAndPassword(clientAuth, email, password);
      await sendVerification(cred.user);
      await signOut(clientAuth);
      setUnverified(false);
      setCooldown(60);
      setNotice(`${email} に確認メールを再送しました。以前のメールのリンクは無効になるので、最新のメールのリンクを開いてください。`);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setError(ERRORS[code] ?? "確認メールを送れませんでした");
    }
    setBusy(false);
  }

  async function resetPassword() {
    setBusy(true);
    setError(null);
    try {
      clientAuth.languageCode = "ja";
      await sendPasswordResetEmail(clientAuth, email, continueUrl("reset"));
      setResetSentTo(email);
      setCooldown(60);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setError(ERRORS[code] ?? "メールを送れませんでした");
    }
    setBusy(false);
  }

  const title = mode === "signup" ? "推し棚をはじめる" : mode === "reset" ? "パスワードの再設定" : "おかえりなさい";

  return (
    <div className="card p-6">
      <h1 className="font-display text-2xl font-bold">{title}</h1>
      <p className="mt-1 text-sm text-ink-2">
        {mode === "reset" ? "登録したメールアドレスに、新しいパスワードを設定するためのリンクを送ります。" : "買ったものの棚を、同じ趣味の仲間と見せ合おう。"}
      </p>

      {notice && <p className="mt-4 rounded-xl bg-surface-2 p-3 text-sm">{notice}</p>}

      {mode === "reset" && resetSentTo && (
        <div className="mt-5 space-y-3 text-sm">
          {/* Same message whether or not the address is registered (no account enumeration). */}
          <p className="rounded-xl bg-surface-2 p-3">
            <b>{resetSentTo}</b> が登録済みであれば、パスワード再設定のメールを送りました。メール内のリンクから1時間以内に新しいパスワードを設定してください。
          </p>
          <p className="text-xs text-ink-2">
            ⚠️ 再送すると、それより前に送ったメールのリンクは使えなくなります。複数届いている場合は<b>いちばん新しいメール</b>のリンクを開いてください。
          </p>
          <button type="button" className="btn-ghost w-full" disabled={busy || cooldown > 0} onClick={resetPassword}>
            {cooldown > 0 ? `再送できるまで ${cooldown} 秒` : "メールが届かないので再送する"}
          </button>
        </div>
      )}

      {mode !== "reset" && (
        <>
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
        </>
      )}

      <form
        hidden={mode === "reset" && !!resetSentTo}
        className={`space-y-3 ${mode === "reset" ? "mt-5" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "signup") signup();
          else if (mode === "reset") resetPassword();
          else run(() => signInWithEmailAndPassword(clientAuth, email, password));
        }}
      >
        <label className="block text-sm">
          メールアドレス
          <input className="input mt-1" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== "reset" && (
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
        )}
        {mode === "login" && (
          <button type="button" className="text-xs text-ink-2 underline" onClick={() => switchMode("reset")}>
            パスワードを忘れた方
          </button>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        {unverified && (
          <button type="button" className="btn-ghost w-full" disabled={busy || cooldown > 0} onClick={resendVerification}>
            {cooldown > 0 ? `再送できるまで ${cooldown} 秒` : "確認メールを再送する"}
          </button>
        )}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "処理中…" : mode === "signup" ? "アカウント作成（確認メールが届きます）" : mode === "reset" ? "再設定メールを送る" : "ログイン"}
        </button>
      </form>

      {mode === "reset" ? (
        <button type="button" className="mt-3 w-full text-center text-sm text-ink-2 underline" onClick={() => switchMode("login")}>
          ログインに戻る
        </button>
      ) : (
        <button type="button" className="mt-3 w-full text-center text-sm text-ink-2 underline" onClick={() => switchMode(mode === "signup" ? "login" : "signup")}>
          {mode === "signup" ? "アカウントをお持ちの方はログイン" : "はじめての方はアカウント作成"}
        </button>
      )}

      {mode === "signup" && (
        <p className="mt-4 text-center text-xs text-ink-2">
          アカウントを作成すると、
          <a href="/terms" target="_blank" className="underline">
            利用規約
          </a>
          と
          <a href="/privacy" target="_blank" className="underline">
            プライバシーポリシー
          </a>
          に同意したものとみなします。
        </p>
      )}

    </div>
  );
}
