import "server-only";
import { requireAdminPermission } from "@/lib/admin";
import Link from "next/link";

export default async function AdminExecutionHistoryPage() {
  await requireAdminPermission("view");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">実行履歴</h2>
          <p className="mt-1 text-slate-600">AI機能の実行履歴とトレース</p>
        </div>
        <Link href="/admin" className="text-blue-600 hover:text-blue-700">
          戻る
        </Link>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">実行ログ</h3>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Trace IDで検索..."
              className="rounded border border-slate-300 px-3 py-1 text-sm"
            />
          </div>
        </div>
        <p className="text-slate-600">実行ログは今後のリリースで利用可能になります。</p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h3 className="text-lg font-semibold text-slate-900">フィルタ</h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium text-slate-700">機能</label>
            <select className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm">
              <option>すべて</option>
              <option>取り込み</option>
              <option>プロフィール自己紹介</option>
              <option>相性診断</option>
              <option>ウォッチャー</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">環境</label>
            <select className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm">
              <option>本番</option>
              <option>ステージング</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">ステータス</label>
            <select className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm">
              <option>すべて</option>
              <option>成功</option>
              <option>失敗</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
