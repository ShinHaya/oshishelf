import "server-only";
import { requireAdminPermission } from "@/lib/admin";
import Link from "next/link";

export default async function AdminPage() {
  await requireAdminPermission("view");

  return (
    <div className="space-y-8">
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-900">概要</h2>
        <p className="mb-6 text-slate-600">システムの実行状況とリリース情報を確認します。</p>
        <Link
          href="/admin/overview"
          className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          概要を表示
        </Link>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-slate-900">実行履歴</h2>
        <p className="mb-6 text-slate-600">AI機能の実行履歴とトレースを確認します。</p>
        <Link
          href="/admin/execution-history"
          className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          実行履歴を表示
        </Link>
      </div>

      <div className="text-sm text-slate-500">
        <p>その他の管理機能は開発中です。</p>
      </div>
    </div>
  );
}
