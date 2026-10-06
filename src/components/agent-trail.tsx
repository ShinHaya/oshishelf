import type { AgentStep } from "@/lib/ai/adk";

const LABELS: Record<string, string> = {
  get_shelf_overview: "棚の全体傾向を確認",
  get_items_by_category: "カテゴリ別に作品を確認",
  search_shelf: "棚を検索",
  compare_shelves: "2人の棚を比較",
  search_their_shelf: "相手の棚を検索",
  search_my_shelf: "あなたの棚を検索",
  list_their_recent: "相手の最近の作品を確認",
  list_recent: "最近の作品を確認",
  list_watched_wishes: "ほしいリストを確認",
  check_price: "商品ページの価格を確認",
  search_new_releases: "Google検索で新作を調査",
  get_recent_notifications: "通知の重複チェック",
  notify_user: "通知を送信",
};

function argSummary(args: Record<string, unknown>) {
  const v = args.query ?? args.keyword ?? args.category ?? args.title;
  return typeof v === "string" ? `「${v}」` : "";
}

/** Visualizes which tools the agent decided to call — makes the agent's autonomy visible. */
export function AgentTrail({ steps }: { steps: AgentStep[] }) {
  if (!steps.length) return null;
  return (
    <details className="mt-2 text-xs text-ink-2">
      <summary className="cursor-pointer select-none">🤖 エージェントの行動ログ（{steps.length}ステップ）</summary>
      <ol className="mt-1.5 space-y-0.5 border-l-2 border-line pl-3">
        {steps.map((s, i) => (
          <li key={i}>
            {LABELS[s.tool] ?? s.tool}
            {argSummary(s.args)}
          </li>
        ))}
      </ol>
    </details>
  );
}
