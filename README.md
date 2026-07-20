# 問い合わせ集約 + AI分類システム（inquiry-hub）

不動産会社向けの問い合わせ集約システムの模擬案件です。Gmail・LINEの問い合わせをSlackに自動集約し、
Claude API が「賃貸・売買・内見・クレーム・その他」の5分類に振り分けます。クレーム判定時は
5分以内に営業部長の個人LINEへ直接通知します。

詳しい要件は [`要件定義書.md`](./要件定義書.md) を参照してください。

## デモ

**https://project5-three-weld.vercel.app**

`ANTHROPIC_API_KEY` だけで動く分類デモです。DB・Slack・LINEには一切書き込みません（副作用ゼロ）。
問い合わせ文を入力すると、実際にSlack・LINEへ届く通知の見た目をプレビューできます。

## 実測結果

模擬データではなく、実際にSupabase・Slack・LINEを本番接続した上で計測した数値です。

| 項目                        | 結果                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| 分類精度                    | 22/22件（`data/case5-test-inquiries.csv`、`npm run test:classification`で再現可） |
| クレーム→LINE Push 所要時間 | 約14秒（要件は5分以内）                                                           |
| 冪等性                      | リトライ時にSlack再投稿が発生しないことを実機で確認済み                           |

分類精度テストは「クレームを見逃さない」「無関係な雑談をクレーム誤判定しない」
「『緊急ではありません』という文言に釣られない」といった、正答率だけでは測れない
境界ケースを含めています（`scripts/test-classification.ts` 冒頭コメント参照）。

## アーキテクチャ

```
Gmail(未接続・下記「スコープ外にしたもの」参照)
LINE(Webhook) ──────────┐
                        │→ Supabase(project5スキーマ) の inquiries テーブルへ投入(pending)
cron-job.org(1分毎、無料) → GET /api/cron/process
  → 固着行の救済 → pending をアトミック取得(SKIP LOCKED、二重処理防止)
  → AI分類(Claude) → Slack投稿 → クレームなら営業部長へLINE Push
  → 各ステップは「既にやったか」をDB列で判定してスキップ(冪等性)
```

`/`（デモ画面）はこの経路とは完全に独立しています。`app/api/demo/classify/route.ts` が
`lib/claude.ts` を直接呼ぶだけで、DB・Slack・LINEには触れません。

詳細なファイル構成は [`CLAUDE.md`](./CLAUDE.md) を参照してください。

### なぜ Vercel純正Cronではなく cron-job.org なのか

Vercel の無料プラン（Hobby）は1日1回のCronしか許可しておらず、1分間隔の実行はデプロイ時点で
拒否されます（Pro プランは月$20）。「クレームは5分以内に通知」という要件と、
低予算案件（月額運用コストを抑える）という前提を両立させるため、無料の外部Cronサービス
（[cron-job.org](https://cron-job.org)）から`CRON_SECRET`付きで1分毎に叩く構成にしました。
Vercel側の`vercel.json`は`{"crons": []}`のままで、スケジューリングは完全に外部サービスに委ねています。

### スコープ外にしたもの

Gmail連携は実装済みですが（`lib/gmail.ts`、`app/api/cron/poll-gmail/route.ts`）、本番では未接続です。
理由は、OAuth同意画面を「本番」ステータスに公開しないとテストモードで7日ごとにトークンが失効する
運用負荷の高さに対して、得られるものが「入力チャネルが1本増える」程度だったためです。
認証情報（`GMAIL_CLIENT_ID`ほか）を環境変数に設定すれば動く状態のままにしてあります。

## 運用マニュアル（想定クライアント向け）

### 普段の確認

- Slackチャネル（賃貸・売買・内見・クレーム・その他の5チャネル）を見るだけでOKです
- クレームと判定された問い合わせは、Slackへの投稿と同時に営業部長の個人LINEにも届きます

### 障害だと感じたら

1. [Vercel Dashboard](https://vercel.com) の Functions ログでエラーを確認
2. Supabase の `project5.inquiries` テーブルで `status = 'failed'` の行を確認
   （5回リトライしても解決しなかった問い合わせです）
3. [cron-job.org](https://cron-job.org) のジョブ実行履歴で、直近の実行が失敗し続けていないか確認
4. 5分以上Slackに新着が来ない場合は開発担当へ連絡

### 監視（コストをかけない方法）

専用の監視ツールは使わず、Supabaseで直近24時間の状況を1本のSQLで確認します。

```sql
select status, count(*) from project5.inquiries
where created_at > now() - interval '24 hours'
group by status;
```

## APIキーローテーション手順

キーが漏洩した場合の対応です。

| サービス                           | 再発行場所                                                  |
| ---------------------------------- | ----------------------------------------------------------- |
| Slack Bot Token / Signing Secret   | Slack App管理画面 → OAuth & Permissions / Basic Information |
| LINE Channel Secret / Access Token | LINE Developers Console → 該当チャネル                      |
| Anthropic API Key                  | Anthropic Console                                           |
| Supabase Service Role Key          | Supabaseダッシュボード → Settings → API                     |

再発行後は、Vercelダッシュボードの Environment Variables を更新し、**再デプロイして初めて反映される**
点に注意してください（環境変数の追加・変更だけでは本番に反映されません）。動作確認は、
デモ画面で分類が通ること、Slackチャネルへのテスト投稿、LINEへのテストPushの3点で行います。

## 運用コスト

固定費はほぼゼロです。

- Vercel Hobby（無料）
- Supabase 無料枠（他の2つのポートフォリオ案件とプロジェクトを共用し、スキーマで分離）
- cron-job.org（無料）
- Slack / LINE Messaging API（無料枠内）
- Claude API のみ従量課金（Anthropic Console側で月額支出上限を設定済み）

## セットアップ（ローカル開発）

```bash
npm install
cp .env.example .env.local   # 各種APIキー・IDを設定
npm run dev
```

`http://localhost:3000` を開くとデモ画面が表示されます。バックエンド（Gmail/LINEの実連携、
Slack投稿、部長へのLINE通知）をローカルで動かすには、Supabase・Slack・LINEの環境変数が必要です。
詳細は `.env.example` のコメントと [`CLAUDE.md`](./CLAUDE.md) を参照してください。

## 主なコマンド

```bash
npm run dev                    # 開発サーバー
npm run build                  # 本番ビルド
npm run lint                   # ESLint
npx tsc --noEmit                # 型チェック
npm run test:classification    # data/case5-test-inquiries.csv で分類精度を実測
```

## 技術構成

Next.js（App Router）/ cron-job.org（外部Cron）/ Supabase / Claude API / Slack API /
LINE Messaging API / Gmail API（未接続）。デプロイ先は Vercel。
