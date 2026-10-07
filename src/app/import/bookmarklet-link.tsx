"use client";

import { useEffect, useRef, useState } from "react";

export function BookmarkletLink({ href, update = false }: { href: string; update?: boolean }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  // React blocks javascript: hrefs in JSX, so set the user-installed bookmark URL on the DOM.
  useEffect(() => { ref.current?.setAttribute("href", href); }, [href]);

  return (
    <div className="space-y-2">
      <a ref={ref} href="#" className="btn-primary cursor-grab" onClick={(e) => {
        e.preventDefault();
        alert("このボタンをブックマークバーにドラッグしてください");
      }}>
        📚 推し棚に取り込む
      </a>
      {update && (
        <>
          <button className="btn-ghost" onClick={async () => {
            try {
              await navigator.clipboard.writeText(href);
              setCopied(true);
            } catch {
              setManualCopy(true);
            }
          }}>{copied ? "コピーしました" : "更新用URLをコピー"}</button>
          <p className="text-xs text-ink-2">既存のブックマークを編集して、URLをコピーした内容に置き換えてください。新しく登録する場合は上のボタンをブックマークバーにドラッグしてください。</p>
          {manualCopy && <textarea className="input text-xs" readOnly value={href} aria-label="ブックマーク更新用URL" onFocus={(e) => e.currentTarget.select()} />}
        </>
      )}
    </div>
  );
}
