# 開発ガイド

推し棚は購入作品を共有するSNSのMVPです。
開発手順とレビュー基準は [docs/development.md](docs/development.md)、製品概要は [README.md](README.md) を参照してください。

## 変更前に読む場所

- `src/app/actions.ts`: ユーザー操作のServer Actions。
- `src/lib/data/`: Firestoreの読み書き。
- `src/lib/session.ts`、`src/lib/access.ts`: 認証、所有者、公開範囲の判定。
- `src/lib/ai/agents/`: AI機能。共有設定は `src/lib/ai/adk.ts`、`gemini.ts`。
- `src/lib/shops.ts`、`safe-fetch.ts`: 商品URLと外部取得。
- `src/lib/types.ts`: 保存データの型。

## 守る仕様

- 取り込んだ作品は下書きにし、公開とAI自己紹介の反映には本人の確認を挟む。
- 書き込みでは認証と所有者をサーバー側で検証する。Firestoreのクライアント直接アクセスは許可しない。
- 下書き、非公開、フォロワー限定の作品を公開向けAI入力に含めない。
- 成人向け表示には閲覧者の成人申告と表示同意を要求する。所有者による閲覧の扱いは既存実装を確認する。
- 成人向け作品をAIに使うには所有者の同意が必要。タイトル、画像、URL、メモは伏せ、ジャンルとタグだけを使う。
- ユーザー指定URLの取得は `safeFetchText` を経由する。モデルの返したIDやURLは信用せず、既存の検証を維持する。
- AIの利用上限、cronのOIDC検証、退会時の関連データ削除を維持する。

## 作業と完了条件

変更を目的に必要な範囲に絞り、既存の構成と命名に合わせてください。
不具合修正と境界条件の変更には、修正前の問題を検出できるテストを追加します。
UIの文言や見た目だけの変更に形式的なテストは追加しません。

完了前に `pnpm check` と `pnpm build` を実行し、差分を [レビュー手順](docs/development.md#レビューとマージ) に沿って確認してください。
報告には変更内容、確認結果、未確認の範囲を記載します。
認証情報や実際の購入履歴をコミットせず、テストは架空データを使います。
開発中のクラウド操作は開発用プロジェクトを対象にし、本番デプロイ、seed、インデックス変更、データ削除を通常の検証として実行しません。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
