"use client";

import { useActionState } from "react";
import { updateSettingsAction } from "@/app/actions";
import { VISIBILITY_LABELS, type UserProfile, type Visibility } from "@/lib/types";

export function SettingsForm({ profile }: { profile: UserProfile }) {
  const [state, action, pending] = useActionState(updateSettingsAction, null);
  return (
    <form action={action} className="card space-y-4 p-5">
      <h2 className="font-display font-bold">プロフィール</h2>
      <label className="block text-sm">
        表示名
        <input name="displayName" defaultValue={profile.displayName} className="input mt-1" required maxLength={40} />
      </label>
      <label className="block text-sm">
        ひとこと（自由記述）
        <textarea name="bio" defaultValue={profile.bio} className="input mt-1 min-h-20" maxLength={400} />
      </label>
      <label className="block text-sm">
        取り込んだ作品の公開範囲（初期値）
        <select name="defaultVisibility" defaultValue={profile.defaultVisibility} className="input mt-1">
          {(Object.keys(VISIBILITY_LABELS) as Visibility[]).map((v) => (
            <option key={v} value={v}>
              {VISIBILITY_LABELS[v]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="twinEnabled" defaultChecked={profile.twinEnabled} className="mt-1" />
        <span>
          AI分身チャットを有効にする
          <span className="block text-xs text-ink-2">ログインユーザーが、あなたの全体公開の棚をもとにしたAI分身と会話できます。</span>
        </span>
      </label>
      {profile.isAdult ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="showAdult" defaultChecked={profile.showAdult} className="mt-1" />
          <span>
            R18作品を表示する
            <span className="block text-xs text-ink-2">18歳以上と申告済みです。OFFの間は他の人のR18作品が非表示になります。</span>
          </span>
        </label>
      ) : (
        <p className="text-xs text-ink-2">R18作品は表示されません（登録時に18歳以上と申告していません）。</p>
      )}
      {state && <p className={`text-sm ${state.ok ? "text-ok" : "text-danger"}`}>{state.ok ? "保存しました" : state.error}</p>}
      <button className="btn-primary" disabled={pending}>
        {pending ? "保存中…" : "保存"}
      </button>
    </form>
  );
}
