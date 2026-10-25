import "server-only";
import { requireAdminPermission } from "@/lib/admin";
import Link from "next/link";

export default async function AdminOverviewPage() {
  await requireAdminPermission("view");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">概要</h2>
          <p className="mt-1 text-slate-600">システムの実行状況とリリース情報</p>
        </div>
        <Link href="/admin" className="text-blue-600 hover:text-blue-700">
          戻る
        </Link>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="text-sm font-medium text-slate-600">実行数（本日）</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">-</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="text-sm font-medium text-slate-600">成功率</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">-</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="text-sm font-medium text-slate-600">平均遅延（p50）</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">-</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="text-sm font-medium text-slate-600">推定費用</div>
          <div className="mt-2 text-3xl font-bold text-slate-900">-</div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h3 className="text-lg font-semibold text-slate-900">詳細情報</h3>
        <p className="mt-4 text-slate-600">詳細な統計情報は今後のリリースで利用可能になります。</p>
      </div>
    </div>
  );
}
