"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyBioAction, generateBioAction } from "@/app/actions";
import type { AiBio, AiBioVariant } from "@/lib/types";
import type { AgentStep } from "@/lib/ai/adk";
import { AgentTrail } from "@/components/agent-trail";

function Traits({ traits }: { traits: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {traits.map((t) => (
        <span key={t} className="chip">
          #{t}
        </span>
      ))}
    </div>
  );
}

function Current({ label, bio }: { label?: string; bio: AiBioVariant }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3 text-sm">
      {label && <p className="mb-1 text-xs font-bold text-ink-2">{label}</p>}
      <p className="font-bold">{bio.catchphrase}</p>
      <p className="mt-1">{bio.text}</p>
    </div>
  );
}

export function BioGenerator({ current, draft: initialDraft, aiUseAdult }: { current: AiBio | null; draft: AiBio | null; aiUseAdult: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState(initialDraft);
  const [text, setText] = useState(initialDraft?.text ?? "");
  const [adultText, setAdultText] = useState(initialDraft?.adult?.text ?? "");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <section id="ai-bio" className="card space-y-3 p-5">
      <div>
        <h2 className="font-display font-bold">✨ AI自己紹介</h2>
        <p className="text-xs text-ink-2">
          プロフィールエージェントが全体公開の棚を調べ、趣味嗜好を推論して自己紹介文を書きます。あなたが確認・編集してから公開されます。
          {aiUseAdult
            ? "成人向け作品をAIに使う設定がONなので、成人向け作品のジャンル・タグも読んだ版（成人向け表示ONの人にだけ表示）もあわせて作ります。"
            : "成人向け作品は使いません。"}
        </p>
      </div>
      {current && !draft && (
        <div className="space-y-2">
          <Current label={current.adult ? "通常版（全員に表示）" : undefined} bio={current} />
          {current.adult && <Current label="成人向け表示ONの人に表示する版" bio={current.adult} />}
        </div>
      )}
      {draft && (
        <div className="space-y-3 rounded-xl border border-accent p-3">
          <div className="space-y-2">
            <p className="text-xs font-bold text-accent">下書き{draft.adult ? "（通常版・全員に表示）" : ""}：{draft.catchphrase}</p>
            <textarea className="input min-h-28" value={text} maxLength={400} onChange={(e) => setText(e.target.value)} />
            <Traits traits={draft.traits} />
          </div>
          {draft.adult && (
            <div className="space-y-2 border-t border-line pt-3">
              <p className="text-xs font-bold text-accent">下書き（成人向け表示ONの人に表示する版）：{draft.adult.catchphrase}</p>
              <textarea className="input min-h-28" value={adultText} maxLength={400} onChange={(e) => setAdultText(e.target.value)} />
              <Traits traits={draft.adult.traits} />
            </div>
          )}
          <AgentTrail steps={steps} />
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await applyBioAction({ text, adultText: draft.adult ? adultText : null });
                if (r.ok) {
                  setDraft(null);
                  router.refresh();
                } else setError(r.error);
              })
            }
          >
            この内容でプロフィールに公開
          </button>
        </div>
      )}
      {note && <p className="text-xs text-warn">{note}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        type="button"
        className="btn-ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            setNote(null);
            const r = await generateBioAction();
            if (r.ok) {
              setDraft(r.data.bio);
              setText(r.data.bio.text);
              setAdultText(r.data.bio.adult?.text ?? "");
              setSteps(r.data.steps);
              setNote(r.data.adultNote);
            } else setError(r.error);
          })
        }
      >
        {pending ? "エージェントが棚を分析中…" : current || draft ? "もう一度生成する" : "自己紹介を生成する"}
      </button>
    </section>
  );
}
