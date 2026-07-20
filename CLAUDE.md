# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの概要

不動産会社向けの問い合わせ集約 + AI分類システム（模擬案件のポートフォリオ実装）。
正式な要件は `要件定義書.md` を参照（`requirements.md` は初期の提案書で、
カテゴリ定義など一部が要件定義書と食い違うため、要件定義書を正とする）。

- Gmail / LINE の問い合わせを Slack に自動集約
- Claude API で「賃貸 / 売買 / 内見 / クレーム / その他」の5分類に振り分け
- クレーム判定時は5分以内に営業部長の個人LINEへPush通知
- `/`（デモ画面）: `ANTHROPIC_API_KEY` だけで動く、誰でも試せる分類デモ。DB/Slack/LINEには一切触らない副作用ゼロ設計

## コマンド

```bash
npm run dev                    # 開発サーバー起動
npm run build                  # 本番ビルド
npm run lint                   # ESLint
npx tsc --noEmit                # 型チェックのみ
npm run test:classification    # data/case5-test-inquiries.csv (22件) で分類精度を実測
```

`ANTHROPIC_API_KEY` が未設定でも `ant auth login`（Anthropic CLI）でログイン済みなら
Anthropic SDK が自動でその認証情報を使う。APIキーをファイルや会話に貼らずに済むため、
ローカル検証ではこちらを優先する。

## アーキテクチャ

Next.js（App Router）+ Vercel Cron + Supabase（キュー）+ Claude API + Slack API + LINE Messaging API + Gmail API。

### データの流れ（バックエンド）

```
Gmail(1分毎ポーリング) ─┐
LINE(Webhook) ──────────┤→ inquiries テーブルに投入(pending)
                        │
Vercel Cron(1分毎) → /api/cron/process
  → 固着行の救済 → pending をアトミック取得(SKIP LOCKED)
  → 分類(Claude) → Slack投稿 → クレームならLINE Push
  → 各ステップは「既にやったか」をDB列で判定してスキップ(冪等性)
```

- `lib/inquiries.ts`: キューの読み書き（登録・アトミック取得・完了・リトライ）
- `lib/claude.ts`: 5分類の判定（structured outputs、`reason` 付き）
- `lib/slack.ts` / `lib/line.ts`: 通知の生成・送信・署名検証
- `lib/gmail.ts`: 時刻ベースのメール取得（未読フラグは使わない。理由はコード内コメント参照）
- `app/api/cron/*`: Cronで叩かれるワーカー（`CRON_SECRET` で保護）
- `app/api/webhooks/*`: LINE/Slackからのリアルタイム受信（署名検証必須）

### デモ画面（`app/page.tsx`）

バックエンドとは独立した経路。`app/api/demo/classify/route.ts` が `lib/claude.ts` を直接呼ぶだけで、
DB・Slack・LINEには触れない。公開エンドポイントのため `lib/rate-limit.ts`（簡易レート制限）と
入力バリデーション（空・型・1000字上限）を必ず経由する。`components/SlackCardPreview.tsx` /
`LinePreview.tsx` は実際の通知の見た目を再現するプレビューで、`lib/slack.ts` / `lib/line.ts` の
実装と齟齬が出ないよう注意する（変更したら両方直す）。

### Supabase：他案件との相乗り【重要】

**この Supabase プロジェクトは project1・project4（別のポートフォリオ案件）と共用している**
（無料プランのプロジェクト数上限のため）。テーブルは `public` ではなく **`project5` 専用スキーマ**
（`supabase/schema.sql`）に置き、`lib/supabase.ts` で `db: { schema: "project5" }` を明示している。

スキーマ変更時は必ず守ること：

- テーブル・関数はすべて `project5.` で完全修飾する
- **スキーマの公開はSQLで行う。ダッシュボードUIは当てにしない**（2026-07-16 に検証済み）。
  Settings → Data API → Exposed schemas のチェックボックスで保存しても実際には反映されず、
  PostgREST は `PGRST106 Invalid schema: project5` を返し続けた（プロジェクト再起動でも直らず）。
  実体は `authenticator` ロールの `pgrst.db_schemas` 変数なので、SQL Editor でこう実行する：

  ```sql
  alter role authenticator set pgrst.db_schemas = 'public, project4, project5';
  notify pgrst, 'reload config';   -- 設定（どのスキーマを公開するか）の再読込
  notify pgrst, 'reload schema';   -- テーブル・関数一覧の再読込
  ```

  **`project4` を必ずリストに含めること。** この変数は上書きなので、省くとproject4のAPIが即死する。

- **`reload config` と `reload schema` は別物。両方必要。** PostgREST は設定とスキーマを
  別々にキャッシュしている。config だけ叩くと `Invalid schema` は消えるが、次に
  `Could not find the function project5.reclaim_stuck_inquiries in the schema cache` で詰まる。
- スキーマ変更後は **project4 のダッシュボードが引き続き動くことを必ず確認**する

## 環境変数

`.env.example` を `.env.local` にコピーして使う。Supabase の値は project1/project4 と
同じもの（相乗りのため）。`CRON_SECRET` は Vercel が Cron 実行時に自動でヘッダーに付与する値。
