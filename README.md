# 情報Ⅰ 学習管理

2027年1月21日の単位認定試験に向けた個人用アプリです。Astroの静的画面、Hono API、OAuth付きStreamable HTTP MCPを1つのCloudflare Workerで提供し、教材・回答・採点履歴をD1に保存します。

GitHubには教材の原文、正答、画像、提出履歴を含めません。実行中のアプリは、指定に従い学習画面をログインなしで提供し、教材と履歴を全利用者で共有します。GitHub OAuthによる本人確認はMCP接続に限定します。実データは `.gitignore` 対象の `info1-exam-preparation/` に置きます。[公開用サンプル](samples/info1-exam-preparation/)は架空のプレースホルダーです。生成物、ローカルDB、バックアップ、秘密鍵もGit管理から除外しています。

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

## 学習と履歴

- 1周目は採点対象の全問、2周目以降は前の周回の誤答だけを出題します。採点待ち・要確認がある間は全問クリアにしません。
- 回答と採点を追記保存します。訂正や再採点で元の回答を消しません。進行中の対象と問題・画像の版を固定し、後の教材更新でも過去の表示を維持します。
- 記述式は設問の半角・全角、大文字・小文字の条件を適用します。論述式はGemma 4（`@cf/google/gemma-4-26b-a4b-it`）による参考評価で、重要概念50点、正確さ30点、条件20点です。低信頼、採点の不整合、処理失敗は要確認にします。本人による修正と再採点ができます。
- 分析画面は設けず、MCPで単元・概念・問題別の正答率、初回と累計、連続正解、所要時間、理解度の推移を集計します。回答が少ない項目はデータ不足として扱います。
- 問題集作成フォームは設けず、MCPから作成します。AI独自問題集は通常周回と分離します。独立検証、対応する計算形式の検算、MCPでの採用確認を経て演習できます。

AIの予約使用量は1日8,000 Neuronsを目安に制限し、上限到達時は保留して翌UTC日に再開します。アカウント全体の厳密な請求上限ではありません。他のWorkerの使用量や予約見積もりとの差は含まれません。課金プランへの変更処理はありません。ローカルではAIを呼び出さず、明示的に `AI_REMOTE=true` と認証済みCLIを用意した場合にだけリモート推論を利用します。

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

権限は `learning:read`、`questions:read`、`answers:read`、`practice:write`、`offline_access` に分けています。正答閲覧・問題集作成は認可画面で個別に許可します。MCPから通常周回、回答、採点を書き換えるツールは提供しません。

## 本番への配置

本番認証の設定とデプロイは保留中です。想定URLは `https://info1-study.namiyama814.workers.dev`、GitHub OAuth Appのコールバックは `https://info1-study.namiyama814.workers.dev/auth/github/callback` です。

1. `npx cf auth login` で個人アカウントにログインします。
2. GitHub OAuth Appを作成し、Client IDとsecretを `.dev.vars` に保存します。チャットやGitに貼り付けないでください。
3. 個人アカウントにD1とKVを作成します。`.env.example` の値を参照し、`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`OAUTH_KV_ID` をシェルにexportします。`.env.example` 自体は読み込み処理を持ちません。
4. `npm run db:migrate -- --remote` でマイグレーションを適用します。
5. `npm run build` の後、`npx cf deploy --prebuilt --mode production --secrets-file .dev.vars` で配置します。秘密情報を省略する場合は、先にCLIでWorkerのsecretを設定してください。
6. 学習画面で自動発行される共有学習用セッションのCookieを非公開ファイルに保存し、`npm run import -- --url https://info1-study.namiyama814.workers.dev --cookie-file private-data/cookie.txt` で教材を取り込みます。

`cloudflare.config.ts` の互換日は、同梱workerdに合わせて2026-11-13に固定しています。新規プロジェクト用のcf CLIを使用し、Wrangler設定やCloudflare Pagesは使用しません。

## バックアップ

共有学習セッションで `/api/backup` からJSONを保存できます。問題の版、画像の版、回答、採点、周回、問題集を含みます。OAuthトークン、セッション、Client secretは含みません。バックアップは教材と同じく非公開で保管してください。復元先は回答履歴のないDBに限定し、既存履歴を上書きしません。

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
