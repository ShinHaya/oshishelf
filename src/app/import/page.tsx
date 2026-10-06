import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/session";
import { listDrafts } from "@/lib/data/items";
import { ImportTabs } from "./import-tabs";

export const metadata: Metadata = { title: "購入履歴を取り込む" };

function bookmarkletCode(origin: string) {
  // Runs on the shop's purchase-history page in the user's own logged-in browser.
  // It only reads links/text from the page and hands them to our receiver window via postMessage.
  const src = `(()=>{const O=${JSON.stringify(origin)};const L=[];document.querySelectorAll('a[href]').forEach(a=>{const i=a.querySelector('img');L.push({href:a.href,text:(a.innerText||(i&&i.alt)||a.title||'').trim().slice(0,300),img:i?(i.currentSrc||i.src||null):null})});const T=(document.body.innerText||'').slice(0,60000);const w=window.open(O+'/import/receive','oshishelf_import');if(!w){alert('ポップアップを許可してください');return}const f=e=>{if(e.origin===O&&e.data==='oshishelf:ready'){w.postMessage({type:'oshishelf:links',page:location.href,links:L.slice(0,3000),text:T},O);removeEventListener('message',f)}};addEventListener('message',f)})()`;
  return `javascript:${encodeURIComponent(src)}`;
}

export default async function ImportPage() {
  const { uid } = await requireProfile();
  const drafts = await listDrafts(uid);
  const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl font-bold">購入履歴を取り込む</h1>
        <p className="text-sm text-ink-2">取り込んだ商品はいったん「下書き」になります。AIのプライバシーチェック後、あなたが確認してから公開されます。</p>
      </div>
      {drafts.length > 0 && (
        <Link href="/import/review" className="card flex items-center justify-between border-accent bg-accent-soft p-4">
          <span className="text-sm">
            確認待ちの下書きが <b>{drafts.length}</b> 件あります
          </span>
          <span className="btn-primary">確認して公開 →</span>
        </Link>
      )}
      <ImportTabs bookmarklet={bookmarkletCode(origin)} />
    </div>
  );
}
