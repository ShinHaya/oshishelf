"use client";

import { useActionState, useState } from "react";
import { updateSettingsAction } from "@/app/actions";
import { VISIBILITY_LABELS, type UserProfile, type Visibility } from "@/lib/types";

export function SettingsForm({ profile }: { profile: UserProfile }) {
  const [state, action, pending] = useActionState(updateSettingsAction, null);
  const [declared, setDeclared] = useState(profile.isAdult);
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
      <fieldset className="space-y-2 rounded-xl bg-surface-2 p-3">
        <legend className="px-1 text-sm font-bold">成人向け（R18）作品の表示</legend>
        <p className="text-xs text-ink-2">
          初期状態では、他の人の棚にある成人向け作品は表示されません。18歳以上の方は、申告したうえで表示をONにできます。OFFのままなら、フォローした人の棚でも成人向けでない作品だけが表示されます。
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="declareAdult" checked={declared} disabled={profile.isAdult} onChange={(e) => setDeclared(e.target.checked)} className="mt-1" />
          <span>
            私は18歳以上です
            <span className="block text-xs text-ink-2">{profile.isAdult ? "申告済みです。" : "虚偽の申告は禁止です。"}</span>
          </span>
        </label>
        {/* A disabled checkbox is not submitted, so keep the existing declaration explicitly. */}
        {profile.isAdult && <input type="hidden" name="declareAdult" value="on" />}
        <label className={`flex items-start gap-2 text-sm ${declared ? "" : "opacity-50"}`}>
          <input type="checkbox" name="showAdult" defaultChecked={profile.showAdult} disabled={!declared} className="mt-1" />
          <span>
            成人向け作品を表示する
            <span className="block text-xs text-ink-2">ONにすると、フィードや他の人の棚に成人向け作品も表示されます。いつでもOFFに戻せます。</span>
          </span>
        </label>
        <label className={`flex items-start gap-2 text-sm ${declared ? "" : "opacity-50"}`}>
          <input type="checkbox" name="aiUseAdult" defaultChecked={profile.aiUseAdult} disabled={!declared} className="mt-1" />
          <span>
            自分の成人向け作品をAIの自己紹介・分身・相性分析に使う
            <span className="block text-xs text-ink-2">
              ONにすると、全体公開している成人向け作品の「ジャンルとタグ」だけをAIに渡します（タイトル・画像は渡しません）。その結果は、成人向け作品の表示をONにしている人にだけ見せます。OFFに戻すと、成人向け作品を反映した自己紹介文はすぐに非表示になります。
            </span>
          </span>
        </label>
      </fieldset>
      {state && <p className={`text-sm ${state.ok ? "text-ok" : "text-danger"}`}>{state.ok ? "保存しました" : state.error}</p>}
      <button className="btn-primary" disabled={pending}>
        {pending ? "保存中…" : "保存"}
      </button>
    </form>
  );
}
