"use client";

import { useState, useTransition } from "react";
import { analyzeCompatAction } from "@/app/actions";
import type { Compatibility } from "@/lib/ai/agents/matcher";
import { AgentTrail } from "@/components/agent-trail";

export function CompatPanel({ targetUid, targetName, initial }: { targetUid: string; targetName: string; initial: Compatibility | null }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (force: boolean) =>
    start(async () => {
      setError(null);
      const r = await analyzeCompatAction(targetUid, force);
      if (r.ok) setData(r.data);
      else setError(r.error);
    });

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display font-bold">🤝 {targetName} さんとの相性</h2>
        {data && (
          <button type="button" className="text-xs text-ink-2 underline" disabled={pending} onClick={() => run(true)}>
            再分析
          </button>
        )}
      </div>
      {!data && (
        <div className="py-6 text-center">
          <p className="text-sm text-ink-2">AIエージェントが2人の棚を見比べて、相性と次に読む（見る）べき作品を提案します。</p>
          <button type="button" className="btn-primary mt-3" disabled={pending} onClick={() => run(false)}>
            {pending ? "分析中…（20秒ほど）" : "相性を分析する"}
          </button>
        </div>
      )}
      {data && (
        <div className={`mt-3 space-y-3 ${pending ? "opacity-50" : ""}`}>
          <div className="flex items-center gap-3">
            <span className="font-display text-4xl font-bold text-accent">{data.score}</span>
            <p className="text-sm">{data.summary}</p>
          </div>
          {data.sharedPoints.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {data.sharedPoints.map((p) => (
                <span key={p} className="chip">
                  {p}
                </span>
              ))}
            </div>
          )}
          {data.picks.length > 0 && (
            <div>
              <p className="text-xs font-bold text-ink-2">あなたへのおすすめ（相手の棚から）</p>
              <ul className="mt-1 space-y-1 text-sm">
                {data.picks.map((p) => (
                  <li key={p.itemId}>
                    <a href={`/go/${p.itemId}`} target="_blank" rel="noopener noreferrer sponsored" className="font-bold text-accent hover:underline">
                      『{p.title ?? "作品"}』
                    </a>
                    <span className="block text-xs text-ink-2">{p.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.icebreakers.length > 0 && (
            <div>
              <p className="text-xs font-bold text-ink-2">話しかけるなら</p>
              <ul className="mt-1 list-inside list-disc text-sm">
                {data.icebreakers.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          <AgentTrail steps={data.steps ?? []} />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
