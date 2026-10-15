# 新規ステージングの構築

Issue #49の環境専用の構成であり、既存本番のリソースをimportしない。
`oshishelf-stg-`で始まる新規プロジェクトをbootstrapで作成する。
提出後のmainは12月1日の審査終了確認まで維持し、継続開発のPR先は`develop`とする。
既存本番へのデプロイは別途承認が必要である。

## 初回に必要な入力と権限

運営者は、検証済みのgcloudアカウントが親Issueの指定メールアドレスと一致することを確認する。
新規のプロジェクトID、課金アカウントID、リージョンを決めて、`infra/bootstrap/terraform.tfvars.example`を同ディレクトリの`terraform.tfvars`へコピーする。
実値とstateはコミットしない。
現在の構成は組織なしプロジェクト向けであり、組織やフォルダの配下に作成する場合は`google_project`への親指定とその権限を先に追加する。

必要な初期権限はプロジェクト作成、課金アカウントへの紐付け（Billing Account User）、作成後のAPI有効化とIAM管理である。
不足時は権限名とエラーを記録して止める。
既存プロジェクトへ代替作成しない。
長期サービスアカウント鍵は作成しない。

```bash
gcloud auth list
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap plan -out=bootstrap.tfplan
terraform -chdir=infra/bootstrap apply bootstrap.tfplan
```

planでは新規プロジェクト以外の変更がないことを確認する。
bootstrapは初回の人間の認証でのみ実行し、Actionsにプロジェクト作成権限や課金管理権限を渡さない。

## stateの移行とロック

bootstrap直後はローカルstateを安全に保管する。
作成した`${PROJECT_ID}-tfstate`へ移すため、`infra/bootstrap/backend.tf`に以下を作成し、`terraform init -migrate-state`で移行する。
バックエンド定義自体には秘密は含まれないが、プロジェクト固有のため作業環境で管理する。

```hcl
terraform {
  backend "gcs" {
    bucket = "REPLACE-tfstate"
    prefix = "bootstrap"
  }
}
```

GCS backendのロックを使い、Actionsも共通concurrency groupで直列化する。
`-lock=false`を使わない。
stateバケットは非公開、バージョニングあり、旧世代は10世代を残す。
stateには90日TTLを適用しない。
移行と復元の確認後にローカルstateを処分し、アクセスできる主体を運営者とTerraform主体に限定する。
bootstrap用stateへの権限と通常stateへの権限は現状バケット単位であるため、Terraform主体は両方を読める。
bootstrapの実行権限自体は持たない。

## 初回のアプリ基盤とイメージ

`infra/staging/terraform.tfvars.example`から入力を作り、次の初期化を行う。
`PROJECT_ID`はこの作業用のシェル変数とし、常に新規ステージングのIDを入れる。

```bash
terraform -chdir=infra/staging init -backend-config="bucket=${PROJECT_ID}-tfstate" -backend-config="prefix=staging"
```

初回のみ循環を解くため、Cloud Run以外の基盤を先行作成する。
`image`には形式を満たす仮のdigest、`app_origin`には暫定の`https://${PROJECT_ID}.firebaseapp.com`を入れる。
次のtarget applyは初回専用であり、通常の更新では使わない。

```bash
terraform -chdir=infra/staging plan \
  -target=data.google_firebase_web_app_config.app -target=google_identity_platform_config.app \
  -target=google_artifact_registry_repository_iam_member.publisher \
  -target=google_firestore_database.app -target=google_firebaserules_release.deny_clients \
  -target=google_firestore_index.app -target=google_firestore_index.taste \
  -target=google_firestore_field.wish_cleanup \
  -target=google_storage_bucket_iam_member.measurements -target=google_storage_bucket_iam_member.prompts \
  -out=initial.tfplan
terraform -chdir=infra/staging apply initial.tfplan
terraform -chdir=infra/staging output -json firebase_web_config
```

出力の4値を`NEXT_PUBLIC_FIREBASE_API_KEY`、`NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`、`NEXT_PUBLIC_FIREBASE_PROJECT_ID`、`NEXT_PUBLIC_FIREBASE_APP_ID`として設定する。
`GOOGLE_CLOUD_PROJECT`も同じIDにする。
公開Firebase設定であっても別環境の値を流用しない。
Dockerはこれら5値をbuild argsで受け取る。
サーバーの起動時にもビルド時のプロジェクトとの不一致を拒否する。

運営者の認証でDockerイメージをビルドして新規Artifact Registryへpushし、そのdigestを`image`に入れる。
以下では4つの公開設定と`GOOGLE_CLOUD_PROJECT`をexport済みとする。

```bash
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
STAGING_IMAGE="asia-northeast1-docker.pkg.dev/${PROJECT_ID}/staging/app:initial"
docker build --build-arg GOOGLE_CLOUD_PROJECT \
  --build-arg NEXT_PUBLIC_FIREBASE_API_KEY --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
  --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID --build-arg NEXT_PUBLIC_FIREBASE_APP_ID \
  -t "$STAGING_IMAGE" .
docker push "$STAGING_IMAGE"
docker inspect --format='{{index .RepoDigests 0}}' "$STAGING_IMAGE"
terraform -chdir=infra/staging plan -out=staging.tfplan
terraform -chdir=infra/staging apply staging.tfplan
```

初回のCloud RunはIAPを有効にしたまま作成する。
組織なし環境のOAuthクライアントはAPIで初期作成できない場合があるため、[Cloud Run IAPの公式手順](https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run)に従って新規プロジェクトのConsoleで初期設定する。
一時的な`allUsers`付与やIAP無効化で回避しない。

通常のplan/applyで作成後、`uri`出力を`app_origin`に入れて再applyする。
Firebaseの承認済みドメインも同時に更新される。
必要に応じてFirebase ConsoleでGoogleログインを有効にし、サポートメールとOAuth設定を行う。
メール認証はTerraformで有効にする。

## Actionsと権限の境界

`develop`へワークフローを反映し、GitHub Environment `staging`を作成する。
運営者をrequired reviewerに指定し、deployment branchは`develop`だけに限定する。
Environment varsに`STAGING_PROJECT_ID`、`STAGING_APP_ORIGIN`、`STAGING_WIF_PROVIDER`、`STAGING_TERRAFORM_ACCOUNT`、`STAGING_DEPLOY_ACCOUNT`を登録する。
後半3値はbootstrap出力を使う。

同一リポジトリの運営者（GitHub ID `23278980`）による`develop`宛PRでのみ自動apply候補となる。
`pull_request_target`は権限が強いため、Environment承認前にPRのTerraform、Dockerfile、ビルドスクリプトをレビューする。
PRのコードを信用できない場合は承認しない。
forkと他ユーザーのPRは実行しない。
OIDCはリポジトリと所有者の数値ID、`develop`のrefとworkflowパスに限定する。
手動実行も`develop`上で行う。
初回構築前にはActionsを有効にしない。

| 主体 | 権限と目的 |
| --- | --- |
| staging-app | 同プロジェクトのFirestore、Firebase Auth、Vertex AI。計測バケットのオブジェクト操作、プロンプト読み取り |
| staging-ai-test | IAPアクセスのみ。Firestore、インフラ管理、デプロイ権限なし |
| staging-deploy | 対象Artifact Registryへのイメージpushのみ |
| staging-terraform | 新規ステージング内のサービス構成とIAM管理。課金管理や既存本番の権限なし |

TerraformはIAMの管理に必要な権限を持ち、自身の権限も変更できる強い主体である。
そのためAIテストへ偽装権限を付与しない。
運営者にはAIテストSAのIDトークン作成権限だけを付与する。

## IAPとアプリのログイン確認

IAPはCloud Run自体に設定するため、標準URLと別名URLの両方に適用される。
Cloud Run InvokerはIAPサービスエージェントだけに付与する。
運営者と`test_users`、AIテストSAにのみIAPアクセスを付与する。
`allUsers`、`allAuthenticatedUsers`は付与しない。

IAPを通過してもFirebaseのログイン状態は作られない。
運営者はIAPを通過したブラウザで、ステージングFirebaseに作成した専用の架空データ用ユーザーとしてログインする。
メール認証は受信できるテスト用アドレスで確認し、既存本番の審査アカウントは使わない。
ログイン後、`/api/session`でhttpOnlyセッションが発行され、棚、取り込み、AI機能が同じ新規プロジェクトを使うことを確認する。

AIは運営者が作成する短命IDトークンでIAPにアクセスする。
[プログラムからのIAPアクセス](https://docs.cloud.google.com/iap/docs/authentication-howto)に従い、対象IAPで受け付けるaudienceを指定する。
ブラウザの画面確認では運営者のIAPセッションを持つ専用ブラウザを使い、同じFirebaseテストユーザーで通常ログインする。
IAPトークンをFirebase IDトークンとして送ったり、テストSAのcustom token発行でアプリの認証を迂回したりしない。

受け入れ時に以下の結果と日時をPRへ記録する。

- 運営者と明示許可したAI主体はIAPを通る。
- 未許可ユーザーと匿名curlは拒否される。リダイレクトだけで成功と判断せず、最終応答がアプリ本文でないことを確認する。
- `uri`の直接URLとCloud Runの別形式URL、revision tag URLでも匿名アクセスは拒否される。
- IAP通過後の未ログイン操作はアプリで拒否される。
- テストログイン後のAuth、Firestore、Vertex AIの対象プロジェクトが一致する。
- Firestoreへのクライアント直接アクセスは拒否される。

cronは構築対象に含めない。
既存のアプリ内OIDC検証は維持しており、後からSchedulerを追加する際はIAP認証とcronのaudience検証の両方を確認する。

## 計測の保存費用と保持

初期の保存先はリージョナルStandard Cloud Storageとする。
1日100件、1件10KiB、90日保持（定常時約88MiB）、月3,000書き込み、3,000読み取り、30回の日付prefix一覧取得を比較の仮定とする。
東京リージョンの有料単価を保守的に丸めた試算であり、無料枠、税、為替、ネットワーク、Vertex AI費用を含めない。
単価は[Storage料金](https://cloud.google.com/storage/pricing)、[Firestore料金](https://cloud.google.com/firestore/pricing)で構築時に再確認する。

| 保存先 | 月額の概算（USD） | 操作、検索、削除の条件 |
| --- | ---: | --- |
| GCS Standard | 約0.02 | 保存約0.003、Class A約0.015、Class B約0.002。日付prefixで絞り、本文の全文走査はしない。最小保存期間なし |
| GCS Nearline | 約0.04 | 保存は約0.002だが操作と取得費用が増える。30日以内の退会削除は早期削除料金も発生 |
| Firestore | 約0.01から0.03 | 書き込み約0.004、読み取り約0.001、保存とインデックス、期限削除の課金を加算。検索の読み取り件数で増加 |

この規模ではFirestore無料枠で安くなる可能性もあり、「GCSが常に最安」とは判断しない。
計測本文をアプリデータから分離し、小さいJSONを日付prefixで一覧でき、複合インデックスなしで運用できる点からGCSを採用する。
大量の小オブジェクトや全件走査が必要になれば再試算する。
Cloud Runは最小0、最大1で、ロードバランサーを追加しない。

90日は「3か月」の暫定値であり、暦月3か月とは異なる。
バケットのライフサイクル削除は非同期であり、90日ちょうどの物理削除を保証しない。
保存側は`createdAt`と`expiresAt = createdAt + 90日`を記録し、表示側は`expiresAt <= now`のデータを必ず除外する契約とする。
本Issueでは保存バケットのみを構築し、計測の書き込みや表示機能は後続Issueで実装する。
別の検索メタデータ保存先は作らない。

退会時はUID prefix配下の計測オブジェクトを即時削除する経路を後続の計測実装に追加し、保持ロックは設定しない。
計測バケットのsoft deleteは無効、バージョニングも無効である。
現在の退会処理にはまだ計測データが存在しないため変更しない。
個人情報と実際の購入履歴は計測へ保存しない。
プロンプトの現行版は別バケットで期限なしとし、旧版の整理は運営者が行う。
プロンプトにユーザーデータを埋め込まない。
stateと運用必須データも90日の計測TTLから除外する。

## 片付けと未確認範囲

運営者が対象IDを確認してからActionsを停止し、OIDCを無効化する。
必要な運用記録を退避し、計測とプロンプトのオブジェクトを明示的に削除してから、Firestoreの削除保護とTerraformのPREVENTを解除する別変更をレビューする。
アプリ基盤をdestroy後、stateを安全に保管し、最後にbootstrapのプロジェクト削除保護を解除して削除する。
stateバケットはforce destroyを無効にしてあり、通常のdestroyで履歴を消さない。
既存本番にはこの手順を適用しない。

実環境のplan/apply、IAPのOAuth初期設定、画面確認はプロジェクト入力と初期権限の確定後に行う。
ローカルのvalidateや単体テストだけで、受け入れ条件の実環境確認を完了としない。
