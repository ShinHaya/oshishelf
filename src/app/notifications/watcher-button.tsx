"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runWatcherNowAction } from "@/app/actions";
import { AgentTrail } from "@/components/agent-trail";
import type { AgentStep } from "@/lib/ai/adk";

export function WatcherButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ summary: string; steps: AgentStep[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3">
      <button
        type="button"
        className="btn-ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await runWatcherNowAction();
            if (r.ok) {
              setResult(r.data);
              router.refresh();
            } else setError(r.error);
          })
        }
      >
        {pending ? "巡回中…（30秒ほど）" : "今すぐ巡回する"}
      </button>
      {result && (
        <div className="mt-2 text-sm">
          <p>{result.summary}</p>
          <AgentTrail steps={result.steps} />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
