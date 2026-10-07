"use client";

import { useActionState } from "react";
import { createProfileAction } from "@/app/actions";

export function OnboardingForm({ defaultName, defaultHandle }: { defaultName: string; defaultHandle: string }) {
  const [state, action, pending] = useActionState(createProfileAction, null);
  return (
    <form action={action} className="card space-y-4 p-6">
      <h1 className="font-display text-2xl font-bold">あなたの棚をつくろう</h1>
      <label className="block text-sm">
        ハンドル（URLになります）
        <div className="mt-1 flex items-center gap-1">
          <span className="text-ink-2">@</span>
          <input name="handle" className="input" required pattern="[a-z0-9_]{3,20}" defaultValue={defaultHandle} placeholder="oshi_lover" />
        </div>
        <span className="text-xs text-ink-2">半角英小文字・数字・_ の3〜20文字</span>
      </label>
      <label className="block text-sm">
        表示名
        <input name="displayName" className="input mt-1" required maxLength={40} defaultValue={defaultName.slice(0, 40)} placeholder="推し活おじさん" />
      </label>
      <label className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-sm">
        <input type="checkbox" name="isAdult" className="mt-1" />
        <span>
          私は18歳以上です
          <span className="block text-xs text-ink-2">チェックすると、設定で成人向け（R18）作品の表示をONにできます（初期状態はOFFです）。虚偽の申告は禁止です。</span>
        </span>
      </label>
      <p className="text-xs text-ink-2">
        はじめることで、
        <a href="/terms" target="_blank" className="underline">
          利用規約
        </a>
        と
        <a href="/privacy" target="_blank" className="underline">
          プライバシーポリシー
        </a>
        に同意したものとみなします。
      </p>
      {state && !state.ok && <p className="text-sm text-danger">{state.error}</p>}
      <button className="btn-primary w-full" disabled={pending}>
        {pending ? "作成中…" : "はじめる"}
      </button>
    </form>
  );
}
