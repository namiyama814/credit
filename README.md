# 情報Ⅰ 学習管理

2027年1月21日の単位認定試験に向けた個人用アプリです。Astroの静的画面、Hono API、OAuth付きStreamable HTTP MCPを1つのCloudflare Workerで提供し、教材・回答・採点履歴をD1に保存します。

GitHubには教材の原文、正答、画像、提出履歴を含めません。実行中のアプリは、指定に従い学習画面をログインなしで提供し、教材と履歴を全利用者で共有します。学習にGitHubログインは不要です。GitHub OAuthによる本人確認はMCP接続と管理APIに使用します。取り込み・復元・バックアップ・採点修正・問題生成などの管理操作は所有者だけが実行できます。実データは `.gitignore` 対象の `info1-exam-preparation/` に置きます。[公開用サンプル](samples/info1-exam-preparation/)は架空のプレースホルダーです。生成物、ローカルDB、バックアップ、秘密鍵もGit管理から除外しています。

## ローカル起動

```sh
npm ci
npm run validate:source
npm run demo
```

別のターミナルで取り込みます。

```sh
npm run import -- --test
```

`http://127.0.0.1:4321/` を開くと、ログインなしで利用できます。ホームは「始める」「問題集を見る」の2ボタンだけです。テスト認証は `test` モードかつループバック接続に限定され、本番では無効です。`demo` はローカル専用DBを利用し、学校サイトへアクセスしません。

標準の取り込み先は171問、採点対象167問、画像5点です。感想4問を通常周回から除外します。画像を先に保存し、問題・画像の件数を照合してから周回を開始できます。取り込み元は `--source /path/to/info1-exam-preparation`、接続先は `--url http://127.0.0.1:4321` で変更できます。取り込みはCLIで行います。

MCP用のGitHub OAuthを試す場合は `.dev.vars.example` を `.dev.vars` にコピーして設定し、`npm run db:migrate`、`npm run dev` を実行します。GitHub OAuth Appのコールバックは `http://127.0.0.1:4321/auth/github/callback` にします。開発DBとテストDBは別です。

## UI確認用モック

ローカルサーバーの起動後、`npm run demo:seed` で「UI確認：選択式」「UI確認：記述式」「UI確認：論述式」の3問題集・計5問を追加できます。全問が架空のサンプルです。モックへの回答も履歴に保存しますが、学習分析・理解度の集計から除外します。学校教材の通常周回には含めず、既存回答を変更しません。再実行しても重複しません。コマンドと追加用APIはローカルの開発・テストモード専用です。

## 学習と履歴

- 1周目は採点対象の全問、2周目以降は前の周回の誤答だけを出題します。採点待ち・要確認がある間は全問クリアにしません。
- 回答と採点を追記保存します。訂正や再採点で元の回答を消しません。進行中の対象と問題・画像の版を固定し、後の教材更新でも過去の表示を維持します。
- 記述式は設問の半角・全角、大文字・小文字の条件を適用します。論述式はGemma 4（`@cf/google/gemma-4-26b-a4b-it`）による参考評価で、重要概念50点、正確さ30点、条件20点です。低信頼、採点の不整合、処理失敗は要確認にします。本人が明示的に許可した場合、MCPから評価を追記して修正・再採点できます。
- 分析画面は設けず、MCPで単元・概念・問題別の正答率、初回と累計、連続正解、所要時間、理解度の推移を集計します。回答が少ない項目はデータ不足として扱います。
- 「問題集を見る」では保存した問題集を選び、その問題集に指定された問題だけを順に解きます。問題文の一覧画面は設けません。問題集作成フォームは設けず、MCPから作成します。AI独自問題集は通常周回と分離します。完了した問題集を再演習すると、新しい演習として保存し、過去の回答は残します。独立検証、対応する計算形式の検算、MCPでの採用確認を経て演習できます。

AIの予約使用量は1日8,000 Neuronsを目安に制限し、上限到達時は保留して翌UTC日に再開します。アカウント全体の厳密な請求上限ではありません。他のWorkerの使用量や予約見積もりとの差は含まれません。課金プランへの変更処理はありません。ローカルではAIを呼び出さず、明示的に `AI_REMOTE=true` と認証済みCLIを用意した場合にだけリモート推論を利用します。

## PWA

ブラウザの「インストール」または「ホーム画面に追加」から利用できます。起動時はホームを単独ウィンドウで開き、画面内にインストール案内は追加しません。192px・512pxのマスク対応アイコンと、iOS用180pxアイコンを用意しています。

Service Workerは公開された画面用のJS・CSS、フォント、アイコン、オフライン画面だけをキャッシュします。教材API・画像API・回答・履歴・OAuth・MCPはキャッシュせず、回答のバックグラウンド再送も行いません。学習には通信が必要です。通信が切れた場合は「オフライン」と「再読み込み」だけを表示し、復帰後に再読み込みできます。公開ビルド資産のハッシュでキャッシュの版を更新します。更新の際に解答中の画面を強制再読み込みしません。

本番はHTTPSで利用します。ローカルのループバック接続でもService Workerを検証できます。実装は [MDNのインストール要件](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) と [Service Worker登録仕様](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register) を参照しています。

## MCP

接続先は本番の `/mcp` です。OAuth認可コード、PKCE、動的クライアント登録、更新・失効を実装しています。GitHubの数値IDで本人を照合します。既定の所有者IDは `253646578` です。

| ツール | 用途 |
| --- | --- |
| `get_learning_context` | AI講師が最初に読む学習状況 |
| `get_round_progress` | 周回・未回答・採点待ち |
| `get_weak_topics` | 苦手概念と根拠 |
| `get_answer_history` | 回答履歴の検索 |
| `get_question_details` | 問題原文・任意の正答 |
| `search_questions` | 単元・形式・理解度などで検索 |
| `recommend_questions` | 根拠付きの復習推薦 |
| `create_practice_set` | 独立した問題集の作成 |
| `approve_practice_set` | 検証済みの問題集を採用 |
| `get_practice_set_results` | 問題集の結果 |
| `get_ai_grading_results` | AI評価と修正の履歴 |
| `review_grading` | 明示許可に基づく評価の追記修正 |
| `regrade_answer` | 理由を残して再採点を依頼 |

権限は `learning:read`、`questions:read`、`answers:read`、`practice:write`、`grading:write`、`offline_access` に分けています。正答閲覧・問題集作成・採点操作は認可画面で個別に許可し、初期状態では未選択です。採点操作は本人の明示的な依頼、`confirm: true`、理由を必須とします。元の回答と過去の評価を変更せず、評価を追加します。

## 本番への配置

本番認証の設定とデプロイは保留中です。想定URLは `https://info1-study.namiyama814.workers.dev`、GitHub OAuth Appのコールバックは `https://info1-study.namiyama814.workers.dev/auth/github/callback` です。

1. `npx cf auth login` で個人アカウントにログインします。
2. [GitHub OAuth App](https://github.com/settings/applications/new) を作成します。Homepage URLは `https://info1-study.namiyama814.workers.dev`、Authorization callback URLは `https://info1-study.namiyama814.workers.dev/auth/github/callback` です。Client IDとsecretだけを `.dev.vars` に保存します（雛形は `.dev.vars.example`）。チャットやGitに貼り付けないでください。登録項目は [GitHub公式手順](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) を参照しています。
3. 個人アカウントにD1とKVを作成します。`.env.example` の値を参照し、`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`OAUTH_KV_ID` をシェルにexportします。`.env.example` 自体は読み込み処理を持ちません。
4. `npm run db:migrate -- --remote` でマイグレーションを適用します。
5. `npm run check:deploy` で設定の不足を確認します。秘密情報は表示しません。揃ったら `npm run deploy` で配置します。設定不足時はデプロイ前に停止します。
6. `/auth/github` から所有者本人を認証し、その管理用セッションのCookieを非公開ファイルに保存して、`npm run import -- --url https://info1-study.namiyama814.workers.dev --cookie-file private-data/cookie.txt` で教材を取り込みます。

`cloudflare.config.ts` の互換日は、同梱workerdに合わせて2026-11-13に固定しています。新規プロジェクト用のcf CLIを使用し、Wrangler設定やCloudflare Pagesは使用しません。

## バックアップ

所有者のGitHub認証済みセッションで `/api/backup` からJSONを保存できます。問題の版、画像の版、回答、採点、周回、問題集を含みます。OAuthトークン、セッション、Client secretは含みません。バックアップは教材と同じく非公開で保管してください。復元先は教材・問題集・履歴のない空DBに限定し、既存データと混合しません。本人確認に必要な利用者・セッションの存在は許可します。

## 検証

```sh
npm run typecheck
npm test
npm run test:e2e
npm run build
npm audit
```

D1実行環境で周回遷移、重複送信、再採点、手動訂正との競合、教材と画像の版、バックアップ復元、無料枠、独自問題の検証をテストします。Playwrightは別の一時DBを作り、スマートフォン画面、原文表示、認証・CSRF、実MCPクライアントによるOAuth接続と全ツール、読み取り専用権限を検証します。テストは架空の問題を使います。

実モデルでは、架空の設問に対する正答・誤答・採点誘導入力の3例で構造化した日本語評価を確認しました。独自問題1問の生成と独立検証も実行済みです。全教材・全生成条件での採点精度を保証する検証ではありません。

## デプロイ前監査（2026-11-16）

認証・MCP、学習データ・採点、フロント・PWAの3担当と統合確認を並列で実施し、担当間でも修正を確認しました。今回確認した主な不具合は修正済みです。

- 本番の匿名学習から管理APIを実行できる問題を、所有者のGitHub認証チェックで遮断。
- MCPの検証結果に含まれる正答が権限なしで返る問題を、正答を含む検証オブジェクトの除去で修正。
- 戻り先パラメータから外部へ誘導される問題を、同一origin・学習パスの制限で修正。
- 入力エラー後の永久ロック、別端末からの重複送信、古い下書きの優先表示を修正。
- 大きい画像でのバックアップ失敗と、復元時に既存教材と混合する問題を修正。
- 古いAI処理の結果・失敗が新しい処理を変更する競合と、再開時の過剰生成を修正。
- 問題集の再演習、モックを分析から除外する処理、PWAの更新漏れを修正。
- 採点の要確認を解消できない状態に対し、明示権限・確認・理由が必要なMCP採点操作を追加。

最終確認は単体テスト40件、ブラウザテスト13件成功、型チェックのエラー・警告0件、ビルド成功、npm auditの既知脆弱性0件です。教材171問・採点対象167問・画像5点を再照合し、Git対象と公開ビルドへの教材原文の混入も確認しました（検出なし）。

実GitHub OAuth Appの登録・秘密情報設定、本番callbackを使った接続確認、Cloudflareの再認証・リソース作成は未実施です。今回の監査中にデプロイは行っていません。複数端末で同じ問題の下書きを同時編集した場合は最終書き込みを採用します。送信済み回答と評価履歴は別に保護します。
