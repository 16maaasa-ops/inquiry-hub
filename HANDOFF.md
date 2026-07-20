# 引き継ぎ書（project5: 問い合わせ集約 + AI分類システム）

作成日: 2026-07-16 / 最終更新: 2026-07-20。このファイルを新しい会話の最初に読んでもらえば、続きから作業できます。

## 現在地（2026-07-20 時点）

**本番稼働中・Cronも稼働中**: https://project5-three-weld.vercel.app

デモ画面・バックエンド（Slack・LINE）・Cronによる自動実行、すべて本番でend-to-end稼働確認済み。

### Cronは Vercel純正ではなく cron-job.org（外部無料サービス）で1分毎に実行

**背景**：`vercel.json` の crons を `* * * * *`（1分毎）で復元してデプロイしたところ、
以下のエラーでデプロイ自体が失敗した。

```
Hobby accounts are limited to daily cron jobs. This cron expression (* * * * *)
would run more than once per day. Upgrade to the Pro plan to unlock all Cron Jobs
features on Vercel.
```

`CLAUDE.md` のアーキテクチャ図は「Vercel Cron(1分毎)」を前提にしているが、**Vercel無料プランでは不可**。
検討した選択肢と決定：

| 選択肢                                              | 判断                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Vercel Pro（月$20）にアップグレード                 | ✗ 「月1.5万円で運用維持」という低予算案件の前提と矛盾するため却下                                        |
| 外部無料Cronサービス（cron-job.org等）で1分毎に叩く | ✓ **採用・稼働中**。費用ゼロを維持でき、「低予算案件での運用判断」としてREADMEにそのまま書ける題材になる |
| 1日1回のCronで妥協                                  | ✗ 「クレーム5分以内通知」の要件が根本的に成立しなくなるため却下                                          |

**設定内容**：cron-job.org に `project5-cron-process` というジョブを作成。
`https://project5-three-weld.vercel.app/api/cron/process` を1分毎にGET、
`Authorization: Bearer <CRON_SECRET>` ヘッダー付き。`vercel.json` の crons は `[]` のまま
（Vercel純正Cronは使わず、外部サービスに完全に委ねる方針）。

**運用方針（2026-07-20 決定）**：**常時稼働させたままにする。** 当初は「ポートフォリオを
常時稼働させるとトークン失効等で壊れたサイトになるリスクがある」として検証後に停止する
方針だったが、cron-job.orgは無料・保守不要で、Gmail OAuth（7日失効）のような時限爆弾も無いため、
このCronに関しては停止する理由がないと判断。デモ画面だけでなく「実際に動いているシステム」を
常に見せられる状態を優先する。停止する場合はcron-job.org側でジョブを無効化すればよい
（Vercel側の変更は不要）。

**ハマったポイント**：cron-job.orgの「IMPORT FROM CURL」機能でヘッダーを取り込んだ際、
Value欄に `Bearer ` プレフィックスが付かず値だけ（例: `masaooo16`）が入ってしまい、
`lib/cron-auth.ts` の `authHeader === \`Bearer ${cronSecret}\``という完全一致チェックに
引っかかり続けて401連発になった。**Header の Value欄は必ず`Bearer <値>` の形（スペース込み）で
入っているか確認すること。** 切り分けには「ローカルから直接curlで叩いて200が返るか」
（Vercel側の設定確認）と「cron-job.orgのHistory/DETAILSで実際に送られた値を見る」
（送信側の設定確認）の両方が有効だった。

## 完了：Slack・LINE本番接続と実機検証（2026-07-20）

**5分SLA・冪等性を含め、システム全体を実機で検証済み。**

- Slack: Bot作成・6チャネル作成・投稿確認済み。最初 `SLACK_BOT_TOKEN` を誤った入力欄に設定してしまい
  `not_authed` エラーで詰まったが、入れ直して解決（Vercelの環境変数は追加/変更後の再デプロイで
  初めて反映される点に起因するハマりどころが複数回発生した）
- LINE: チャネル作成・署名検証・Webhook受信確認済み。`LINE_MANAGER_USER_ID` は
  Webhook経由で実際にメッセージを受けて取得（一時的にuserIdをログ出力するコードを追加し、
  取得後に削除する形で対応）
- **5分SLA実測**：クレーム文面の投入(`created_at`)からLINE Push送信(`line_notified_at`)まで
  **約14秒**。300秒のSLAに対して大きく余裕あり
- **冪等性の実演**：LINE設定前に一度Slack投稿だけ成功していた行が、後日のリトライで
  Slack再投稿はスキップし、LINE通知だけ実行された（`slack_message_ts`が変わらないことで確認）。
  設計通りに機能している証拠
- 検証には `/api/debug/seed`（CRON_SECRET保護の一時エンドポイント：キュー投入・Slack直接テスト・
  最新行の状態確認）を使用。**検証完了後に削除済み**（本番に残すべきでない裏口のため）

### スコープの決定（2026-07-17）

- **Gmail連携は実装のみでスコープ外とする**。理由: 設定が最も重く（OAuth同意画面の本番公開が必須）、
  デモへの貢献が最小（入力チャネルが1本増えるだけ）で、テスト状態だと7日でトークン失効し
  「放置すると壊れる」リスクが最も高い。コードは残し、READMEに「認証情報を入れれば動く」と明記する。
- **LINE + Slack のみ本番接続する**。これだけで見せ場（受信→AI分類→Slack振り分け→クレーム検知→
  部長へLINE Push）と、課題の要求（署名検証・冪等性・5分SLA）は全て満たせる。
- **測定したら Cron は止める**。ポートフォリオとして常時稼働させると、トークン失効や無料枠切れで
  «壊れたサイト» になるリスクがあるため。5分SLAを実測してスクショを撮ったら `crons: []` に戻す。

## プロジェクト概要

不動産会社向けの問い合わせ集約 + AI分類システム（模擬案件のポートフォリオ実装）。
詳細仕様は `要件定義書.md`、実装計画とレビュー内容の全履歴は
`/Users/yukitaniguchi/.claude/plans/pure-swinging-sunrise.md` を参照。

- Gmail / LINE の問い合わせを Slack に自動集約、AIが「賃貸/売買/内見/クレーム/その他」に分類
- クレーム判定時は5分以内に営業部長の個人LINEへPush通知
- `/`（デモ画面）: `ANTHROPIC_API_KEY` だけで動く、誰でも試せる分類デモ。DB/Slack/LINEには一切触らない

## 完了していること

1. **バックエンド実装一式**（`lib/`, `app/api/`）：Gmail/LINEポーリング・Webhook、AI分類（`reason`付き）、
   Slack投稿・ボタン操作、LINE通知、Cronワーカー（二重処理防止・固着行救済・リトライ）
2. **致命的バグを修正済み**：存在しない`processed_at`列への書き込みでキューが無限ループするバグ、
   エラーハンドリング欠落、`lib/claude.ts`の遅延クライアント化
3. **デモ画面完成・ブラウザ実機確認済み**（`app/page.tsx` ほか）：Tailwind v4、6サンプル、
   Slack/LINEプレビュー、分類精度22/22件実測、レート制限・入力バリデーション実装済み
4. **静的チェックはすべて green**：`npx tsc --noEmit` / `npm run lint` / `npm run build`
5. **`ant auth login`でAnthropic認証済み**（APIキーを会話に出さずに`npm run test:classification`等が実行可能）
6. **Anthropic Consoleの支出上限設定 済み**

## 完了：Supabase相乗り設定（2026-07-17 解決）

project1・project4と同じSupabaseプロジェクト（`mock-project-1`）への`project5`専用スキーマでの
同居が**完了**。`notify pgrst, 'reload schema';` の実行で解決した。

- 接続確認済み：`/api/cron/process` → `{"ok":true,"claimed":0,"doneCount":0,"failedCount":0}` (HTTP 200)
- **project4のダッシュボードが引き続き動くことを実機確認済み**（件数表示・会話履歴とも正常）

ハマりどころ（ダッシュボードUIは反映されず、SQLの`pgrst.db_schemas`が唯一の正。
`reload config`と`reload schema`は別キャッシュで両方必要）の詳細は
**`CLAUDE.md` の「Supabase：他案件との相乗り」と `supabase/schema.sql` 冒頭コメントに移設済み**。
※ 以前これらのファイルには「SQLから実行しない」という**誤った指示**が書かれていたが、
2026-07-17 に実体験に基づき修正した。

## 完了：Vercel 本番デプロイ（2026-07-17）

- 本番ドメイン（安定・Webhook登録用）: `https://project5-three-weld.vercel.app`
- `ANTHROPIC_API_KEY` 設定済み（Production + Preview、Sensitive ON）
- 動作確認済み: `/` → 200、`/api/demo/classify` → 200（クレーム/緊急を正しく判定）、
  `/api/cron/process` → 401（環境変数未設定のため正しく拒否）
- Vercel CLI インストール済み（`vercel whoami` → `16maaasa-ops`、
  プロジェクト `yuki-taniguchi-s-projects/project5`）

## 残っていること（優先順）

1. **Slack設定**：Botトークン・Signing Secret、5チャネル（賃貸/売買/内見/クレーム/その他）+
   `#system-alerts`、Interactivity URL登録（`https://project5-three-weld.vercel.app/api/webhooks/slack`）
2. **LINE設定**：Messaging APIチャネル、Webhook URL
   （`https://project5-three-weld.vercel.app/api/webhooks/line`）、営業部長のユーザーID取得
3. **Vercelに環境変数を追加**（下記「必要な環境変数」参照）。値はダッシュボードで直接入力する
   （秘密情報を会話に貼らない方針のため）
4. `vercel.json` の crons を復元（**Gmailは除外して2本**）→ 再デプロイ
5. **クレーム文面を実送信 → 5分以内にLINE Pushが届くか測定 → スクショ**
6. **crons を `[]` に戻して停止**
7. README仕上げ（構成図・運用マニュアル・キーローテーション手順・測定結果・精度22/22）
8. `git init` → GitHubへ（**まだGitリポジトリではない**）
9. 発注元企業への確認：問い合わせ本文がSupabase/Slack/Anthropicに渡ることの同意

### 必要な環境変数（コードから抽出した確定リスト）

Vercelに未設定のもの。`ANTHROPIC_API_KEY`のみ設定済み。

| 変数                                                                                  | 取得元                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`                              | `.env.local`と同じ値（project1/4と共通）                                 |
| `CRON_SECRET`                                                                         | 任意の文字列。VercelがCron実行時に`Authorization: Bearer <値>`で自動送信 |
| `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`                                   | LINE Developers → Messaging APIチャネル                                  |
| `LINE_MANAGER_USER_ID`                                                                | 部長役アカウントで友だち追加 → Webhookに届く`source.userId`              |
| `SLACK_BOT_TOKEN` (`xoxb-`) / `SLACK_SIGNING_SECRET`                                  | Slack App設定                                                            |
| `SLACK_CHANNEL_RENTAL` / `SALE` / `VIEWING` / `COMPLAINT` / `OTHER` / `SYSTEM_ALERTS` | チャネル**ID**（`C01234ABCD`形式。名前ではない）                         |
| ~~`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN`~~                 | **スコープ外**（上記「スコープの決定」参照）                             |

## vercel.json の crons を空にしている【測定時のみ復元 → その後また空に戻す】

2026-07-17、初回デプロイにあたり Slack/LINE 未設定のため毎分エラーが出るのを避ける目的で
`vercel.json` を `{"crons": []}` にした。

**5分SLAの測定をするときだけ**、以下に戻して再デプロイする（**Gmailはスコープ外なので `poll-gmail` は入れない**）：

```json
{
  "crons": [
    { "path": "/api/cron/process", "schedule": "* * * * *" },
    { "path": "/api/cron/daily-summary", "schedule": "0 22 * * *" }
  ]
}
```

**測定してスクショを撮ったら、`{"crons": []}` に戻して再デプロイすること。**
ポートフォリオとして常時稼働させると、無料枠切れやトークン失効で «壊れたサイト» になるため
（「スコープの決定」参照）。READMEには「Cronは検証後に停止している。復元するにはvercel.jsonを戻すだけ」
と明記する。

## 覚えておいてほしい運用ルール（このセッション中にユーザーから指示済み）

- **計画・レビューフェーズはOpus、実装フェーズはSonnetで進める**運用（メモリ保存済み：
  `~/.claude/projects/-Users-yukitaniguchi-claude-mock-project-project5/memory/feedback_model_phase_preference.md`）
- モデル切り替えは会話の相手（Claude）からは実行不可。ユーザーに`/model`での切り替えを依頼する
- APIキー等の秘密情報は会話に貼らない方針（`ant auth login`や、シェル変数経由でのcurlテストで代替してきた）
- `.env.local`・`.env.example`はRead/Bash catでの直接閲覧がツール側でブロックされている
  （書き込みはWriteツールで可能）。中身を確認したい場合はユーザーに聞くか、内容を推測せず尋ねること

## 主要ファイル

- `要件定義書.md` — 正式仕様（`requirements.md`は古い提案書、参考程度）
- `CLAUDE.md` — アーキテクチャ・コマンド一覧（最新化済み）
- `supabase/schema.sql` — project5専用スキーマのDDL（実行済み、内容は正しいことを確認済み）
- `data/case5-test-inquiries.csv` — 分類精度テストデータ（22件、22/22正解を実測済み）
- `/Users/yukitaniguchi/.claude/plans/pure-swinging-sunrise.md` — 全実装計画とレビュー指摘の詳細
