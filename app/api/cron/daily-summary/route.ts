// 日次サマリ Cron（毎朝1回）
// 「エラーすら出ずに静かに止まる」障害（環境変数ミス・トークン失効・Cron停止）に
// 気づけるよう、前日の処理件数を毎朝 #system-alerts に投稿する。

import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { supabase } from "@/lib/supabase";
import { postSystemAlert } from "@/lib/slack";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const today = new Date(yesterday);
  today.setDate(today.getDate() + 1);

  const { count: receivedCount } = await supabase
    .from("inquiries")
    .select("*", { count: "exact", head: true })
    .gte("received_at", yesterday.toISOString())
    .lt("received_at", today.toISOString());

  const { count: failedCount } = await supabase
    .from("inquiries")
    .select("*", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("received_at", yesterday.toISOString())
    .lt("received_at", today.toISOString());

  const { count: complaintCount } = await supabase
    .from("inquiries")
    .select("*", { count: "exact", head: true })
    .eq("category", "クレーム")
    .gte("received_at", yesterday.toISOString())
    .lt("received_at", today.toISOString());

  const dateLabel = yesterday.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });
  const text = [
    `📊 ${dateLabel} の処理サマリ`,
    `受信: ${receivedCount ?? 0}件（うちクレーム: ${complaintCount ?? 0}件）`,
    `失敗（要確認）: ${failedCount ?? 0}件`,
  ].join("\n");

  await postSystemAlert(text);

  return NextResponse.json({ ok: true });
}
