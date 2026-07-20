-- 問い合わせキュー兼履歴テーブル（project5 専用スキーマ）
--
-- 【重要】このSupabaseプロジェクトは project1・project4（別のポートフォリオ案件）と
-- 共用しており、無料プランのプロジェクト数上限を使い切っているため新規プロジェクトを作れない。
-- そのため public スキーマではなく専用の project5 スキーマにテーブルを作り、
-- 他案件のテーブル・関数と衝突・混在しないようにする（project4 が確立したパターンを踏襲）。
--
-- 実行前に、Supabase の SQL Editor で以下を実行し、public に過去の残骸がないか確認すること：
--   select tablename from pg_tables where schemaname='public' and tablename='inquiries';
--   select proname from pg_proc p join pg_namespace n on p.pronamespace=n.oid
--     where n.nspname='public' and proname in ('claim_pending_inquiries','reclaim_stuck_inquiries');
-- 何か返ってきたら、project1 の資産でないことを確認してから削除すること。
--
-- 【手作業・必須】このファイルの実行後、SQL Editor で以下を実行してスキーマを公開する。
--   alter role authenticator set pgrst.db_schemas = 'public, project4, project5';
--   notify pgrst, 'reload config';   -- 設定（公開スキーマ）の再読込
--   notify pgrst, 'reload schema';   -- テーブル・関数一覧の再読込
--
-- ダッシュボード（Settings → Data API → Exposed schemas）のチェックボックスUIは
-- 使わないこと。2026-07-16 の検証で、保存しても実際には反映されず PostgREST が
-- `PGRST106 Invalid schema: project5` を返し続けることを確認した（再起動でも直らず）。
-- 設定の実体は authenticator ロールの pgrst.db_schemas 変数であり、SQL が唯一の正。
--
-- 注意1: db_schemas は「上書き」なので project4 を必ず含める。省くと project4 の API が即死する。
-- 注意2: reload config と reload schema は別キャッシュ。両方必要。config だけだと
--        `Could not find the function project5.reclaim_stuck_inquiries in the schema cache` で詰まる。

create extension if not exists pgcrypto;

create schema if not exists project5;

create table if not exists project5.inquiries (
  id uuid primary key default gen_random_uuid(),

  -- 受信内容
  channel text not null,               -- 'gmail' | 'line'
  sender text,                         -- 送信者名（メールはアドレス併記、LINEは表示名）
  body text not null,                  -- 本文（非テキストは固定文言）
  received_at timestamptz not null,    -- 実際に問い合わせが届いた時刻

  -- 分類結果
  category text,                       -- '賃貸' | '売買' | '内見' | 'クレーム' | 'その他'
  is_urgent boolean not null default false, -- クレーム=緊急のフラグ（LINE Push対象かどうか）
  reason text,                         -- AIの判定理由（誤分類時の原因調査・デモ表示に使用）

  -- キュー制御（二重処理防止・固着行の救済に使用）
  status text not null default 'pending', -- pending / processing / done / failed / skipped
  retry_count int not null default 0,
  processing_started_at timestamptz,      -- processing になった時刻。5分超で救済対象
  processed_at timestamptz,               -- done になった時刻（5分SLAの実測に使用）

  -- 冪等性（ステップ単位でのリトライ時に二重通知を防ぐ）
  slack_message_ts text,               -- Slack投稿済みならそのメッセージID
  slack_channel_id text,               -- 投稿先チャネルID（ボタン操作の更新に使用）
  line_notified_at timestamptz,        -- 部長LINE通知済みの時刻

  -- 対応状況
  assigned_to text,                    -- 担当者（Slackユーザー表示名）
  resolved_at timestamptz,             -- 対応済にした時刻

  -- 重複排除
  external_id text unique,             -- GmailメッセージID or LINEメッセージID

  created_at timestamptz not null default now()
);

-- ワーカーが pending を取り出す際に使う複合インデックス
create index if not exists inquiries_status_received_idx
  on project5.inquiries (status, received_at);

-- Row Level Security を有効化。
-- ポリシーを何も作らないことで「service role 以外は何も読み書きできない」状態になる。
-- サーバー側の API Routes は SUPABASE_SERVICE_ROLE_KEY を使ってアクセスするため影響を受けない。
-- 他案件と共用のDBであるため、この防御は必ず残す。
alter table project5.inquiries enable row level security;

-- ============================================================
-- 二重処理防止：pending な行を「取得」と「processing への変更」を
-- 1つのアトミックな操作にするための関数。
-- FOR UPDATE SKIP LOCKED により、複数のワーカーが同時に実行されても
-- 同じ行を2つの処理が同時に掴むことがない（Cronの重複起動対策）。
--
-- set search_path = '' により、この関数はスキーマ検索パスに一切頼らず、
-- すべてのテーブル参照を完全修飾（project5.inquiries）で書くことを強制される。
-- 他スキーマのテーブルを誤って参照する事故を防ぐ、Supabase推奨の安全設定。
-- ============================================================
create or replace function project5.claim_pending_inquiries(claim_limit int default 10)
returns setof project5.inquiries
language plpgsql
set search_path = ''
as $$
begin
  return query
  update project5.inquiries
  set status = 'processing',
      processing_started_at = now()
  where id in (
    select id from project5.inquiries
    where status = 'pending'
    order by received_at asc
    limit claim_limit
    for update skip locked
  )
  returning *;
end;
$$;

-- ============================================================
-- 固着行の救済：processing のまま5分以上経過した行を pending に戻す。
-- サーバー落ち・タイムアウトで宙に浮いた問い合わせを取りこぼさないための仕組み。
-- ============================================================
create or replace function project5.reclaim_stuck_inquiries()
returns int
language plpgsql
set search_path = ''
as $$
declare
  reclaimed_count int;
begin
  with reclaimed as (
    update project5.inquiries
    set status = 'pending',
        processing_started_at = null
    where status = 'processing'
      and processing_started_at < now() - interval '5 minutes'
    returning id
  )
  select count(*) into reclaimed_count from reclaimed;
  return reclaimed_count;
end;
$$;

-- ============================================================
-- 権限。project5 は Supabase Auth を使わず service_role のみでアクセスするため
-- （project4 と異なり authenticated ロールへの付与は不要）。
-- テーブル・関数の作成が済んだ後、ファイル末尾でまとめて付与する
-- （grant はその時点で存在するオブジェクトにしか効かないため、先に書くと無効）。
-- ============================================================
grant usage on schema project5 to service_role;
grant select, insert, update, delete on all tables in schema project5 to service_role;
alter default privileges in schema project5
  grant select, insert, update, delete on tables to service_role;

-- PostgreSQLは関数作成時に全ロール（PUBLIC）へ自動でEXECUTE権限を与えるため、
-- 明示的に剥がしてから service_role にのみ付与する（多層防御）。
revoke execute on all functions in schema project5 from public;
grant execute on all functions in schema project5 to service_role;
