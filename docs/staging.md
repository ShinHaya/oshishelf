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

TerraformのGoogleプロバイダーは`billing_project`と`user_project_override`でクォータ用プロジェクトもステージングへ固定する。
ローカルADCでIdentity Toolkit APIを初期化する際にも、この指定が必要である。

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

ローカルDockerが利用できない場合は、同じプロジェクトのCloud Buildを初回ビルドに利用できる。
bootstrapでCloud Build APIを有効化し、初回target planに`google_storage_bucket_iam_member.build_source`、`google_project_iam_member.build_logs`、`google_artifact_registry_repository_iam_member.build`を追加する。
`.gcloudignore`でローカル環境変数、認証ファイル、Terraform入力とstateをアップロードから除外する。
専用の`staging-build`サービスアカウントはアプリやインフラを変更できない。
ソース保存バケットは1日で削除対象になり、soft deleteと保持ロックを設定しない。

```bash
gcloud builds submit --project="$PROJECT_ID" --region=asia-northeast1 \
  --service-account="projects/${PROJECT_ID}/serviceAccounts/staging-build@${PROJECT_ID}.iam.gserviceaccount.com" \
  --gcs-source-staging-dir="gs://${PROJECT_ID}-build-source/source" \
  --config=infra/cloudbuild.yaml \
  --substitutions="_REGION=asia-northeast1,_FIREBASE_API_KEY=${NEXT_PUBLIC_FIREBASE_API_KEY},_FIREBASE_AUTH_DOMAIN=${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN},_FIREBASE_APP_ID=${NEXT_PUBLIC_FIREBASE_APP_ID}" .
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
| staging-ai-test | IAPアクセスと、同ステージングのログ、リソース構成、Cloud Run、API状態の読み取り。Firestoreの作品データ、インフラ管理、デプロイ権限なし |
| staging-deploy | 対象Artifact Registryへのイメージpushのみ |
| staging-build | 初回Cloud Build用。ソースバケット読み取り、Artifact Registryへのpush、ビルドログ書き込み |
| staging-terraform | 新規ステージング内のサービス構成とIAM管理。課金管理や既存本番の権限なし |

TerraformはIAMの管理に必要な権限を持ち、自身の権限も変更できる強い主体である。
そのためAIテストへ偽装権限を付与しない。
運営者にはAIテストSAの短命アクセストークンとIDトークンの作成権限を付与する。
署名（signBlob／signJwt）や鍵作成の権限は付与しない。

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

## apply失敗時のAIによる診断

Terraform applyが失敗した場合、AIはGitHub Actionsのログだけで原因を断定しない。
失敗したrunのSHA、対象プロジェクトID、リソースアドレス、APIエラー、時刻を特定した後、同じ新規ステージングのCloud Loggingと実リソースを直接確認する。
実リソースが部分的に作成された可能性もあるため、再apply前に現状とstateの差を調べる。
認証や権限で直接確認できなければ、そのエラーと未確認項目を報告し、確認済みとして扱わない。

AIの直接調査では`staging-ai-test`を偽装し、Terraform用やアプリ用のSAを使わない。
AI用SAにはCloud Loggingの通常ログ、Cloud Assetの構成メタデータ、Cloud Runの構成、API有効化状態の読み取りを付与する。
Data Access監査ログを読むPrivate Logs Viewer、Firestoreのドキュメント読み取り、Storageのオブジェクト読み取りや更新、IAM変更は付与しない。
Cloud Asset APIとLogging APIはbootstrapで有効化する。

以下は読み取り専用の調査例である。
`PROJECT_ID`はbootstrapで作成したステージングIDと照合し、失敗時刻付近に期間を絞る。

```bash
DIAGNOSTIC_SA="staging-ai-test@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud logging read 'severity>=ERROR' --project="$PROJECT_ID" \
  --impersonate-service-account="$DIAGNOSTIC_SA" --freshness=1h --limit=50 \
  --format='json(timestamp,resource.type,protoPayload.methodName,protoPayload.status)'
gcloud asset search-all-resources --scope="projects/${PROJECT_ID}" \
  --impersonate-service-account="$DIAGNOSTIC_SA" \
  --format='table(assetType,name,location,state)'
gcloud run services describe oshishelf-staging --region=asia-northeast1 \
  --project="$PROJECT_ID" --impersonate-service-account="$DIAGNOSTIC_SA" \
  --format='yaml(metadata.name,status.conditions,status.latestReadyRevisionName,status.url)'
gcloud services list --enabled --project="$PROJECT_ID" \
  --impersonate-service-account="$DIAGNOSTIC_SA" --format='value(config.name)'
```

ログが0件でも、リクエストが到達していない場合やログの遅延があるため、正常の証拠にはしない。
必要に応じて対象リソースやAPI名で期間内の監査ログを絞り込む。
ログの生本文や環境変数全体をPRへ貼らず、認証情報と個人情報を除いたエラーコード、対象リソース、状態を記録する。

AIはソースの修正後に、通常のレビューとステージングActionsを通して再plan/applyする。
診断用SAによる直接修復、既存本番の調査への切り替え、無条件の再試行、state削除やforce-unlockは行わない。
bootstrap自体が失敗して診断SAが存在しない場合は、運営者の読み取りによる確認結果を取得するか、認証不足として具体的に報告する。

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


## 2026年10月15日の初回構築記録

手元のgcloud認証とTerraformのADCが、いずれも指定運営者のメールアドレスであることを確認した。
有効な既存課金アカウントを選択し、bootstrap planが新規ステージングへの作成37件のみで、既存本番の変更や削除を含まないことをJSONでも検査した。

`oshishelf-stg-20261015`（プロジェクト番号`698676314360`）の作成は成功した。
課金紐付けではCloud Billing APIが`400 failedPrecondition`と`QuotaFailure: Cloud billing quota exceeded`を返し、bootstrap applyは停止した。
実リソースを直接確認し、プロジェクトは`ACTIVE`、`billingEnabled: false`、課金アカウント未紐付けであることを確認した。
別プロジェクトの利用や既存プロジェクトの課金解除は行っていない。

ログ調査用に新規プロジェクトのLogging APIを有効化した。
最初のログ読み取りは`Permission denied for all log views`で失敗した。
その後、実プロジェクトのIAMで運営者にOwnerが付与されていることを確認し、エラーログの再取得は成功したが該当件数は0件だった。
ログに記録がないことを課金紐付け成功の証拠にはしていない。
診断SAはbootstrap停止のため未作成であり、この初回診断は運営者の認証で行った。

失敗後のTerraform stateでは作成済みプロジェクトがtaintedになっていた。
実在と状態を確認したうえで当該リソースのみuntaintし、再作成を避けた。
再planでは当該プロジェクトは課金設定のupdateとなり、全体で削除がないことを確認した。
stateとローカル入力はgitignore対象に保管し、stateとplanのパーミッションは600に設定した。
GCS backend用バケットは未作成のため、state移行はまだ行っていない。

続行には[課金クォータの増枠申請](https://support.google.com/code/contact/billing_quota_increase)等によるCloud Billing側の制限解除が必要である。
解除後は同じプロジェクトとstateで新しいplanを生成し、変更対象を確認してからapplyする。
Cloud Run、Firebase、Firestore、各SA、バケット、OIDC、画面確認、Actions applyは未実施である。


## 課金設定後の構築と検証記録

2026年10月15日、利用者による課金設定後に`billingEnabled: true`を確認して構築を再開した。
bootstrapと通常構成をapplyし、Cloud Run、Firebase Authentication、Firestoreと全インデックス、拒否ルール、各SA、バケット、GitHub OIDCを作成した。
bootstrap stateもGCSの`bootstrap` prefixへ移行し、通常構成は`staging` prefixを使う。

初回のAuthentication設定は、ADCのクォータ用プロジェクト未指定で403になった。
APIのエラーと設定リソースの404を確認し、Googleの両プロバイダーに`billing_project`と`user_project_override`を指定して再applyしたところ成功した。
既存本番の設定は変更していない。

初回イメージは専用の`staging-build`を使ったCloud Buildで作成した。
ビルドIDは`d3feeb86-cfb7-4b96-9d4f-c0c08fd391d2`で、Next.jsの本番ビルドとpushが成功した。
アップロード対象154ファイルを確認し、ローカル環境設定、認証ファイル、Terraform入力とstateを含まないことを検査した。

Cloud Runは`asia-northeast1`に配置し、実サービスの`Ready: True`と`iap-enabled: true`を確認した。
canonical URLは`https://oshishelf-staging-y7cynxjxla-an.a.run.app`で、APP_ORIGINとFirebase承認済みドメインもこのURLに更新した。
数値形式のURLは`https://oshishelf-staging-698676314360.asia-northeast1.run.app`である。

GitHub Environment `staging`を作成し、運営者のrequired reviewerと`develop`限定のbranch policyを設定した。
プロジェクトID、APP_ORIGIN、WIF provider、Terraform用とデプロイ用のSAをEnvironment varsに登録した。
ワークフローはPRのdevelopへの反映後に実行できる構成であり、現在のPRを勝手にマージして検証してはいない。

以下は実環境で確認済みである。

- Firebaseメール認証が有効で、Authの設定リソースは新規プロジェクト番号を返す。
- 新規プロジェクトのVertex AIへ架空の短いプロンプトを送り、応答を得た。ただし運営者認証によるAPI単体確認であり、アプリ経由のAI操作は未確認。
- Firestoreの架空のドキュメントへの未認証アクセスは403（Missing or insufficient permissions）。
- AI診断SAによるAPI一覧、Cloud Assetの実リソース一覧、Cloud Runの状態、Cloud Logging読み取りが成功。初回のトークン発行権限の伝播前には拒否されたが、伝播後に成功した。
- Cloud RunのInvokerはIAPサービスエージェントのみ。IAPのアクセサーは運営者とAI診断SAのみで、公開主体の付与なし。
- 計測バケットは東京リージョン、90日ライフサイクル、soft delete無効、public access prevention有効。

IAPのOAuthクライアント初期設定はまだ完了していない。
canonical URL、数値形式URLの匿名アクセスと、AI主体のIDトークンによるアクセスはいずれも502（Empty Google Account OAuth client ID(s)/secret(s).）で、アプリ本文は返らない。
この状態を「許可主体のアクセス成功」や「未許可主体の403確認済み」とは扱わない。
このセッションではブラウザ操作が利用できないため、運営者にCloud Consoleで初期設定を依頼した。
初期設定後のIAPアクセス、Firebaseセッション、ログイン済み画面、アプリ経由のAI操作、Actions applyは未確認である。

再planでは、APIが返す無効な電話認証設定による差分が出たため、電話認証OFFも明示した。
最終的にbootstrapと通常構成の両方でplanが変更なしとなることを確認した。
ローカルの`pnpm check`は300テストを含め成功し、Terraformのvalidateとmock test 3件も成功した。
