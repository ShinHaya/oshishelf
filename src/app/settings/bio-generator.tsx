"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyBioAction, generateBioAction } from "@/app/actions";
import type { AiBio } from "@/lib/types";
import type { AgentStep } from "@/lib/ai/adk";
import { AgentTrail } from "@/components/agent-trail";

export function BioGenerator({ current, draft: initialDraft }: { current: AiBio | null; draft: AiBio | null }) {
  const router = useRouter();
  const [draft, setDraft] = useState(initialDraft);
  const [text, setText] = useState(initialDraft?.text ?? "");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <section id="ai-bio" className="card space-y-3 p-5">
      <div>
        <h2 className="font-display font-bold">✨ AI自己紹介</h2>
        <p className="text-xs text-ink-2">プロフィールエージェントが全体公開の棚（R18・非公開を除く）を調べ、趣味嗜好を推論して自己紹介文を書きます。あなたが確認・編集してから公開されます。</p>
      </div>
      {current && !draft && (
        <div className="rounded-xl bg-surface-2 p-3 text-sm">
          <p className="font-bold">{current.catchphrase}</p>
          <p className="mt-1">{current.text}</p>
        </div>
      )}
      {draft && (
        <div className="space-y-2 rounded-xl border border-accent p-3">
          <p className="text-xs font-bold text-accent">下書き：{draft.catchphrase}</p>
          <textarea className="input min-h-28" value={text} maxLength={400} onChange={(e) => setText(e.target.value)} />
          <div className="flex flex-wrap gap-1">
            {draft.traits.map((t) => (
              <span key={t} className="chip">
                #{t}
              </span>
            ))}
          </div>
          <AgentTrail steps={steps} />
          <button
            type="button"
            className="btn-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await applyBioAction(text);
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
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        type="button"
        className="btn-ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await generateBioAction();
            if (r.ok) {
              setDraft(r.data.bio);
              setText(r.data.bio.text);
              setSteps(r.data.steps);
            } else setError(r.error);
          })
        }
      >
        {pending ? "エージェントが棚を分析中…" : current || draft ? "もう一度生成する" : "自己紹介を生成する"}
      </button>
    </section>
  );
}
