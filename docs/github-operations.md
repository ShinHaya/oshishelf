# Issue作業ツールの運用

この文書は追加したSkillsとスクリプトの利用手順を定めます。
製品仕様と安全上の制約は [README](../README.md) と [AGENTS.md](../AGENTS.md)、検査とマージ条件は [開発ガイド](development.md) を優先します。

## 1. 導入元と適用範囲

[ai-coding-template](https://github.com/ShinHaya/ai-coding-template) のコミット `4aa273e474890fa878df181f0d6814f8f024cd66` から、`skills/`、Issue管理スクリプト、対応するテスト、設定例、Issueテンプレートを取り込みました。
テンプレートの製品文書、AGENTS.md、モデルを固定するエージェント定義、Claude専用の操作制限は取り込んでいません。
Skillsの実体は `skills/` に置き、`.agents/skills/` と `.claude/skills/` から相対シンボリックリンクで参照します。

必要なツールはNode.js 22、pnpm、Git、GitHub CLI (`gh`)、`jq` です。
シェル検査には `shellcheck` を使います。
エージェントの実行には、利用するCLIのインストールと認証が別途必要です。

## 2. Issue用worktree

新規Issueでは専用worktreeを作成します。
補助ツールは `origin/develop` を基準とし、取得に失敗した場合は既存の `origin/develop`、次にローカルの `develop` を使います。
利用可能な基準がなければ停止します。
既存のIssue用worktreeがある場合は `handoff-issue` で再開し、作業途中の変更を保持します。

```bash
bash scripts/issue-worktree.sh status 123 --json
bash scripts/issue-worktree.sh create 123 short-slug --agent codex --session session-123
cd .worktrees/issue-123-short-slug
pnpm install --frozen-lockfile
```

作業パスとブランチは `issue-<番号>-<slug>`、所有セッションと引き継ぎ情報は共有Gitディレクトリの `issue-worktrees/` に保存されます。
同じIssueの同時編集を避け、引き継ぎには `handoff`、占有の解除には `release` を使います。
`cleanup <issue> --pr <pr>` はマージ済みPR、変更のないworktree、占有解除を確認してから削除します。

## 3. Issueの作成と計画

`create-issue` と [Issueテンプレート](../.github/ISSUE_TEMPLATE/implementation-plan.md) を利用できます。
計画と詳細設計はIssue本文かコメントに置きます。
依存関係はGitHub Issuesの `Blocked by`、優先度は必要に応じて `priority:P0` から `priority:P3` を使います。
GitHub ProjectsやProject用トークンは不要です。

## 4. ローカル検査

```bash
pnpm check
pnpm build
# 任意: クローンごとにコミット前のlintと型検査を有効化
pnpm setup:hooks
```

`pnpm check` は既存の検査に加え、`test:orchestrator` と `test:worktree` を実行します。
worktreeのテストは一時ディレクトリと架空のリポジトリを使い、GitHubへ接続しません。
フックは明示的なセットアップでのみ有効になります。
既存の `core.hooksPath` がある場合は設定変更前に内容を確認してください。

## 5. 複数Issueの調整

複数Issueの実行を依頼された場合に `orchestrate-project-issues` を使用します。
実行可能なCLIを検出し、まずdry-runで依存関係と割り当てを確認します。

```bash
node scripts/project-issue-capabilities.mjs
node scripts/project-issue-orchestrator.mjs --issues 123,124 --dry-run \
  --max-parallel 2 --release-policy pr-created \
  --parent-agent codex --parent-model <現在のモデル>
```

設定の既定値は [設定例](../config/project-issue-orchestrator.example.yaml) を参照してください。
親ランタイムは既定（`auto`）で、5時間利用枠が50%以上残る場合だけワーカー候補に加わります。
残量を取得できない場合は加わりません。`--parent-worker-mode always|never` で固定できます。
必要なら `state/project-issue-orchestrator.yaml` にコピーします。
`state/` と `.worktrees/` はGit管理対象外です。
TypeSafeへのIssue分類は既定でOFFです。
有効にするとIssue本文を外部APIに送るため、秘密情報や個人情報を含むIssueには使いません。
このツールの導入は本番デプロイやクラウド操作の承認を意味しません。

## 6. PR

PRは `develop` に向け、本文の独立した行に `Closes #123` を記載します。
mainの凍結時刻を含むブランチ運用は [開発ガイド](development.md#レビューとマージ) に従います。

## 7. マージ

必要なCIが成功し、未解決の不具合がないことを確認します。
Issueの実装依頼だけでマージや本番デプロイを実行しません。

## 8. レビュー

単一Issue用Skillはpush前に読み取り専用のreviewerを一度実行し、指摘に対して一度だけ修正します。
利用可能な別経路がなければ共通経路を使い、経路検出に失敗した場合は未実施としてPRに記載します。
レビュー結果、修正内容、検査結果、未確認の範囲をPRに残します。
既存のレビュー基準は [開発ガイド](development.md#レビューとマージ) に従います。
