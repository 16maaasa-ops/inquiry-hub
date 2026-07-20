// Supabase クライアント（サーバー専用）
// service role key は全権限を持つため、API Routes 以外（ブラウザ向けコード）では絶対に使わない。
//
// クライアント生成は実際に使われるタイミング（リクエスト処理時）まで遅延させている。
// モジュール読み込み時に環境変数チェックをすると、ビルド時のページデータ収集
// （実行時ではなくビルド時にモジュールが評価される）で環境変数未設定エラーになってしまうため。
//
// db.schema は "project5" を明示している。このSupabaseプロジェクトは他案件
// （project1, project4）と共用しており、project5 専用スキーマにテーブルを作っているため
// （supabase/schema.sql 参照）。.from() だけでなく .rpc() もこのスキーマ配下の関数を呼ぶ。

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// SupabaseClient の第2ジェネリック引数はスキーマ名（デフォルト "public"）。
// project5 スキーマを使うため明示しておかないと、.from()/.rpc() の型が
// public スキーマ前提になり、db.schema オプションの指定と型が食い違ってエラーになる。
// Database 型（1つ目・3つ目の引数）は generated types を使っていないため any のまま
// （Supabase公式ドキュメントでも型生成を省略する場合の標準的な書き方）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Project5Client = SupabaseClient<any, "project5", any>;

let client: Project5Client | null = null;

function getClient(): Project5Client {
  if (client) return client;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Supabase の環境変数が設定されていません（NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client = createClient<any, "project5">(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    db: { schema: "project5" },
  });
  return client;
}

export const supabase: Project5Client = new Proxy({} as Project5Client, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver);
  },
});
