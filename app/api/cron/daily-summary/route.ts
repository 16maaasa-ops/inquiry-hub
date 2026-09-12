// 日次サマリ Cron（毎朝1回）
// 「エラーすら出ずに静かに止まる」障害（環境変数ミス・トークン失効・Cron停止）に
// 気づけるよう、前日の処理件数を毎朝 #system-alerts に投稿する。

import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { supabase } from "@/lib/supabase";
import { postSystemAlert } from "@/lib/slack";

// 「受信0件」だけでは、平常（土日で問い合わせが無い）とワーカー全滅（受信は
// 溜まっているが処理されていない）を区別できない。ワーカーが止まっている間、
// 問い合わせは pending/processing のまま溜まるだけで failed にはならないため、
// failedCount も0のままで「異常なし」に見えてしまう。そこで「今この瞬間、
// 未処理（pending/processing）が何件・最古はいつからか」を別枠で見る。
// released_at の昇順で1件取れば最古の未処理行が分かる。
async function getOldestPendingAgeMinutes(): Promise<{
  count: number;
  oldestMinutes: number | null;
} | null> {
  const { count, error: countError } = await supabase
    .from("inquiries")
    .select("*", { count: "exact", head: true })
    .in("status", ["pending", "processing"]);
  if (countError) return null;

  const { data, error: oldestError } = await supabase
    .from("inquiries")
    .select("received_at")
    .in("status", ["pending", "processing"])
    .order("received_at", { ascending: true })
    .limit(1);
  if (oldestError) return null;

  const oldest = data?.[0]?.received_at;
  const oldestMinutes = oldest
    ? Math.floor((Date.now() - new Date(oldest).getTime()) / 60000)
    : null;

  return { count: count ?? 0, oldestMinutes };
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const today = new Date(yesterday);
  today.setDate(today.getDate() + 1);

  const { count: receivedCount, error: receivedError } = await supabase
    .from("inquiries")
    .select("*", { count: "exact", head: true })
    .gte("received_at", yesterday.toISOString())
    .lt("received_at", today.toISOString());

  const { count: failedCount, error: failedError } = await supabase
    .from("inquiries")
    .select("*", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("received_at", yesterday.toISOString())
    .lt("received_at", today.toISOString());

  const { count: complaintCount, error: complaintError } = await supabase
    .from("inquiries")
    .select("*", { count: "exact", head: true })
    .eq("category", "クレーム")
    .gte("received_at", yesterday.toISOString())
    .lt("received_at", today.toISOString());

  const pending = await getOldestPendingAgeMinutes();

  const dateLabel = yesterday.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });

  // 集計自体がエラーで失敗した場合、件数を0として静かに投稿すると「異常なし」に
  // 見えてしまう（DBが落ちていても受信0件のサマリが届く、が最悪のケース）。
  // 集計できなかったことを明示して投稿する。
  const hasQueryError =
    receivedError || failedError || complaintError || !pending;
  if (hasQueryError) {
    await postSystemAlert(
      `⚠️ ${dateLabel} の処理サマリを集計できませんでした（Supabaseへの問い合わせが失敗）\n` +
        "Vercelログで SKIP_DB_TIMEOUT / エラーを確認してください",
    );
    return NextResponse.json({ ok: false, reason: "aggregation_failed" });
  }

  const oldestLabel =
    pending.count === 0
      ? "なし"
      : `${pending.oldestMinutes ?? "?"}分前（${pending.count}件）`;

  const text = [
    `📊 ${dateLabel} の処理サマリ`,
    `受信: ${receivedCount ?? 0}件（うちクレーム: ${complaintCount ?? 0}件）`,
    `失敗（要確認）: ${failedCount ?? 0}件`,
    `最古の未処理: ${oldestLabel}`,
  ].join("\n");

  await postSystemAlert(text);

  return NextResponse.json({ ok: true, status: "processed" });
}
