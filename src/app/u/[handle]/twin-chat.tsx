"use client";

import { useRef, useState, useTransition } from "react";
import { twinChatAction } from "@/app/actions";
import type { Item } from "@/lib/types";
import { AgentTrail } from "@/components/agent-trail";
import type { AgentStep } from "@/lib/ai/adk";

interface Msg {
  role: "user" | "twin";
  text: string;
  items?: Item[];
  steps?: AgentStep[];
}

const SUGGESTIONS = ["最近ハマってる作品は？", "初心者におすすめの1冊を教えて", "どんなジャンルが好き？"];

function renderText(text: string, items: Item[] = []) {
  const byId = new Map(items.map((i) => [i.id, i]));
  return text.split(/(\[\[item:[A-Za-z0-9]+\]\])/g).map((part, idx) => {
    const id = part.match(/^\[\[item:([A-Za-z0-9]+)\]\]$/)?.[1];
    if (!id) return <span key={idx}>{part}</span>;
    const it = byId.get(id);
    return it ? (
      <a key={idx} href={`/go/${it.id}`} target="_blank" rel="noopener noreferrer sponsored" className="font-bold text-accent underline">
        『{it.title}』
      </a>
    ) : null;
  });
}

export function TwinChat({ handle, name }: { handle: string; name: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);

  function send(text: string) {
    const message = text.trim();
    if (!message || pending) return;
    const history = msgs.map(({ role, text }) => ({ role, text }));
    setMsgs((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setError(null);
    start(async () => {
      const r = await twinChatAction(handle, history, message);
      if (r.ok) setMsgs((m) => [...m, { role: "twin", text: r.data.reply, items: r.data.items, steps: r.data.steps }]);
      else setError(r.error);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    });
  }

  return (
    <section className="card flex flex-col p-4">
      <h2 className="font-display font-bold">💬 {name} さんのAI分身と話す</h2>
      <p className="text-xs text-ink-2">公開棚だけを知っているAIです。本人ではありません。</p>
      <div className="mt-3 max-h-80 min-h-32 flex-1 space-y-2 overflow-y-auto">
        {msgs.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="chip hover:bg-accent-soft" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div className={`inline-block max-w-[90%] rounded-2xl px-3 py-2 text-left text-sm ${m.role === "user" ? "bg-accent text-accent-ink" : "bg-surface-2"}`}>
              {m.role === "twin" ? renderText(m.text, m.items) : m.text}
            </div>
            {m.steps && <AgentTrail steps={m.steps} />}
          </div>
        ))}
        {pending && <p className="text-xs text-ink-2">分身が棚を見ています…</p>}
        <div ref={endRef} />
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input className="input" value={input} maxLength={500} onChange={(e) => setInput(e.target.value)} placeholder="おすすめを聞いてみよう" />
        <button className="btn-primary" disabled={pending || !input.trim()}>
          送信
        </button>
      </form>
    </section>
  );
}
