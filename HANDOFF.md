# 引き継ぎ書（project5: 問い合わせ集約 + AI分類システム）

作成日: 2026-07-16 / 最終更新: 2026-07-25。このファイルを新しい会話の最初に読んでもらえば、続きから作業できます。

## 現在地（2026-07-25 時点）

**本番稼働中・Cronも稼働中**: https://project5-three-weld.vercel.app

デモ画面・バックエンド（Slack・LINE）・Cronによる自動実行、すべて本番でend-to-end稼働確認済み。
**このプロジェクトは実装・インフラ面では完成している。** README も仕上げ済み（`README.md`）。

2026-07-25 に再確認したこと（コミット済みコードに変更なし＝同一内容の再デプロイのみ実施）：

- 公開URL: トップ `200` / `/api/demo/classify` `200`（「内見」を正しく判定）/ `/api/cron/process` 認証なしで `401`（正しく保護）
- Vercelの環境変数一式（Anthropic/Supabase/Slack/LINE/Cron）はすべて設定済みであることを `vercel env ls` で確認
- Supabase相乗り（project4との共存）も正常

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

### Cron失敗メール対策（2026-09-12）

cron-job.orgから`project5-cron-process`の失敗メール（500）が繰り返し届く問題を調査・修正した。
`npx vercel logs`で実測した原因は、コードのバグではなく**Supabase無料プランの一時的な
Gateway Timeout**（直近22分で23回中4回、約17%）。1分毎の実行で成功と失敗が交互に起きるたびに
cron-job.orgの通知がリセット→再送されるため、数分おきにメールが飛び続けていた。

**対処（実装済み）**：

- `lib/retry.ts`（新規）：`isTransientDbError`（HTTPステータス/PostgreSQLエラーコード基準で
  一時的か恒久的かを判定。判定できないものは恒久＝500に倒す）と`withRetry`（一時的エラーのみ
  その場で再試行。デッドライン15秒）
- `lib/supabase.ts`：fetchに8秒タイムアウトを追加。これが無いと`withRetry`が
  `maxDuration=60`を使い切り、Vercel自身が504を返してメールが結局止まらない
- `app/api/cron/process/route.ts`：キュー取得が一時的エラーで再試行後も解決しなければ、
  500ではなく200（`status:"skipped_run"`）を返す。恒久的な異常は従来どおり500のまま
- `supabase/schema.sql`：固着行の救済しきい値を**5分→90秒**に短縮
  （`maxDuration=60`なので、処理中の行が60秒を超えて`processing`のままなのは原理的に無い。
  以前の5分だと、claimの応答だけタイムアウトした行が5分間放置され、受信から6分超で
  LINE通知が飛び5分SLAを破りうる穴があった）
- `app/api/cron/daily-summary/route.ts`：受信件数だけでは「土日で問い合わせが無い」のと
  「ワーカーが止まって溜まっている」を区別できないため、「未処理(pending/processing)が
  何件・最古はいつからか」を追加。集計自体がエラーで失敗した場合も明示して投稿する

**★重要（引き継ぐ人へ）**：cron-job.orgに登録されているジョブは`process`の1本だけで、
`daily-summary`（毎朝1回、#system-alertsへ投稿）はコードは完成しているが**cron-job.org側で
まだ登録していない可能性がある**（このHANDOFFにこれまで登録の記録が無かったため）。
上記の「一時的エラーは200で静かにする」対処は、この日次サマリが実際に動いていることが
前提になっている。**必ずcron-job.orgの管理画面で登録状況を確認し、無ければ追加すること**
（`https://project5-three-weld.vercel.app/api/cron/daily-summary`を1日1回、
`Authorization: Bearer <CRON_SECRET>`付きでGET。コード変更は不要）。

**5分SLAは「cron-job.orgの実行間隔1分」と「救済しきい値90秒」の2つがセットで支えている。**
片方だけを動かすとSLAが崩れるため、変更する場合は両方を見直すこと
（間隔を緩めると失敗行の再処理が遅れる、しきい値を伸ばすと救済までの遅延がSLAを超える）。

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
- ~~**測定したら Cron は止める**~~ → **2026-07-20 に方針変更・撤回。常時稼働させたままにする**。
  当初は「常時稼働させるとトークン失効や無料枠切れで «壊れたサイト» になる」と考えていたが、
  Cronを cron-job.org（無料・保守不要）に委譲し、失効の時限爆弾がある Gmail をスコープ外にしたことで、
  停止する理由がなくなった。「実際に動いているシステム」を常に見せられる状態を優先する（冒頭「現在地」参照）。

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
  `/api/cron/process` → 認証ヘッダーなしのアクセスは 401（`CRON_SECRET`で正しく保護。cron-job.orgは正しいヘッダーを付けて200を得ている）
- Vercel CLI インストール済み（`vercel whoami` → `16maaasa-ops`、
  プロジェクト `yuki-taniguchi-s-projects/project5`）

## 残っていること

**コードは実装済みだが、以下2つの手作業がデプロイ後に必須**（上記「Cron失敗メール対策」参照）：

1. **Supabase SQL Editorで `supabase/schema.sql` の `reclaim_stuck_inquiries` を再実行**：
   救済しきい値を5分→90秒に変更したが、`create or replace function`は自動では反映されない。
   デプロイ前にSQL Editorで実行しておくこと（さもないと救済が5分のままでSLAの穴が残る）。
2. **cron-job.orgで`daily-summary`ジョブの登録有無を確認・無ければ追加**：
   `https://project5-three-weld.vercel.app/api/cron/daily-summary`を1日1回、
   `Authorization: Bearer <CRON_SECRET>`付きでGET。今回の「一時的エラーは200で静かにする」
   対処は、この日次サマリが実際に動いていることが前提（コード変更は不要）。

以下は任意／対外的な項目。

1. **発注元企業への確認（模擬案件のため実施は任意）**：問い合わせ本文が Supabase / Slack / Anthropic の
   各サービスへ送信されることへの同意。実運用に移す場合のみ必要。
2. **Gmail連携を有効化する場合のみ**（現状スコープ外）：`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` /
   `GMAIL_REFRESH_TOKEN` を Vercel に設定し、OAuth同意画面を「本番」ステータスに公開する
   （テスト状態だと7日でトークン失効。詳細は上記「スコープの決定」）。

### 環境変数（すべて Vercel に設定済み・2026-07-25 に `vercel env ls` で確認）

以下は Production + Preview に設定済み。**新規に登録する作業は残っていない。**

- AI: `ANTHROPIC_API_KEY`
- Supabase: `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`（project1/4と共通の値）
- Cron: `CRON_SECRET`（cron-job.org が `Authorization: Bearer <値>` で送信）
- LINE: `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_MANAGER_USER_ID`
- Slack: `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` /
  `SLACK_CHANNEL_{RENTAL,SALE,VIEWING,COMPLAINT,OTHER,SYSTEM_ALERTS}`（値はチャネル**ID**）
- Gmail（`GMAIL_*`）のみ**スコープ外で未設定**

値の入力はダッシュボードで直接行う方針（秘密情報を会話に貼らないため）。
変更後は**再デプロイして初めて反映される**点に注意（追加・変更だけでは本番に反映されない）。

## vercel.json の crons は恒久的に `{"crons": []}`【復元しないこと】

Vercel 無料プラン（Hobby）は1日1回のCronしか許可せず、1分毎（`* * * * *`）はデプロイ時点で
拒否される（`Hobby accounts are limited to daily cron jobs`）。そのためスケジューリングは
**cron-job.org（外部無料サービス）に完全委譲**しており、`vercel.json` は空のままが正しい状態。
Vercel純正Cronを復元するとデプロイが失敗する。運用を止めたいときは cron-job.org 側でジョブを
無効化すればよく、Vercel側の変更は不要（詳細は冒頭「現在地」節）。

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
