// キュー処理ワーカー Cron（1分間隔）
//
// 処理の流れ（1件ごと）：
//   1. 固着行の救済（claimPendingInquiries 内で実行）
//   2. pending をアトミックに取得（SKIP LOCKED で二重処理を防止）
//   3. 分類（未分類なら）→ Slack投稿（未投稿なら）→ クレームならLINE通知（未通知なら）
//   4. 成功: done / 失敗: リトライ upper下ならpendingに戻す、上限到達ならfailed+アラート
//
// 各ステップは「既にやったこと」をDBの列で判定してスキップする（冪等性）。
// これにより、DBへの記録が成功している限り、リトライで同じ通知が2回飛ぶことはない。
// ただし完全ではない：「外部へ通知を送る → DBに"送った"と記録する」の順で処理するため、
// 通知の送信直後にDB記録が失敗する（ネットワーク瞬断など）と、次回のリトライで
// 未記録とみなされ、通知がもう一度送られうる。この隙間まで塞ぐには送信側に冪等キーを
// 持たせる等が必要だが、発生頻度が低いため現状は許容している。

import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { classifyInquiry } from "@/lib/claude";
import { postInquiryCard, getPermalink, postSystemAlert } from "@/lib/slack";
import { notifyManagerOfComplaint } from "@/lib/line";
import {
  claimPendingInquiries,
  markInquiryDone,
  markInquiryFailedOrRetry,
  updateInquiryClassification,
  updateInquirySlackInfo,
  markLineNotified,
} from "@/lib/inquiries";
import { DbError, isTransientDbError, withRetry } from "@/lib/retry";
import type { Inquiry } from "@/lib/types";

export const maxDuration = 60;

async function processOne(inquiry: Inquiry): Promise<void> {
  let current = inquiry;

  // ステップ1: 分類（まだ分類していない場合のみ）
  if (!current.category) {
    const { category, isUrgent, reason } = await classifyInquiry(current.body);
    await updateInquiryClassification(current.id, category, isUrgent, reason);
    current = { ...current, category, is_urgent: isUrgent, reason };
  }

  // ステップ2: Slack投稿（まだ投稿していない場合のみ＝冪等性）
  if (!current.slack_message_ts) {
    const result = await postInquiryCard(current);
    if (!result.ok || !result.ts || !result.channel) {
      throw new Error(`Slack投稿に失敗しました: ${result.error ?? "unknown"}`);
    }
    await updateInquirySlackInfo(current.id, result.ts, result.channel);
    current = {
      ...current,
      slack_message_ts: result.ts,
      slack_channel_id: result.channel,
    };
  }

  // ステップ3: クレームなら部長へLINE即時通知（まだ通知していない場合のみ＝冪等性）
  if (
    current.category === "クレーム" &&
    current.is_urgent &&
    !current.line_notified_at
  ) {
    const permalink =
      current.slack_channel_id && current.slack_message_ts
        ? await getPermalink(current.slack_channel_id, current.slack_message_ts)
        : null;
    await notifyManagerOfComplaint(current, permalink);
    await markLineNotified(current.id);
  }

  await markInquiryDone(current.id);
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let claimed: Inquiry[];
  try {
    // Supabase無料プランは時々応答が長引く（Gateway Timeout）。POSTのRPCは
    // ライブラリ内部でリトライされないため、ここだけ自前でその場再試行する
    claimed = await withRetry(() => claimPendingInquiries(10));
  } catch (error) {
    if (isTransientDbError(error)) {
      // 一時的なDB不調で、再試行しても解決しなかった。1分後の次回実行で
      // 処理されるので今回は正常終了として扱う（500を返すと外部Cronサービスから
      // 失敗通知メールが飛び続けてしまうため）。SKIP_DB_TIMEOUT はログ検索用タグ。
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof DbError ? error.status : undefined;
      const code = error instanceof DbError ? error.code : undefined;
      console.warn(
        `SKIP_DB_TIMEOUT [cron/process] キュー取得が再試行後もタイムアウト。` +
          `1分後の次回実行で再処理されます。status=${status} code=${code} message=${message}`,
      );
      return NextResponse.json({
        ok: true,
        status: "skipped_run",
        reason: "db_timeout",
        claimed: 0,
        doneCount: 0,
        retriedCount: 0,
        failedCount: 0,
        message: "Supabaseの応答が遅く再試行も失敗。次回(1分後)に再処理します",
      });
    }
    throw error; // 恒久的な異常は500のまま（気づけるようにする）
  }

  let doneCount = 0;
  let retriedCount = 0;
  let failedCount = 0;

  for (const inquiry of claimed) {
    try {
      await processOne(inquiry);
      doneCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTransient = isTransientDbError(error);
      const { willRetry } = await markInquiryFailedOrRetry(inquiry, {
        isTransient,
      });
      if (willRetry) {
        retriedCount += 1;
      } else {
        failedCount += 1;
        // 一時的なDB不調が原因で失敗上限に達した場合は文面を分ける。
        // 「エラー: Gateway Timeout」とだけ出すと読んだ人がコードのバグだと誤読するため。
        const reasonText = isTransient
          ? "Supabaseの一時的な不調が30分以上続いたため処理できませんでした"
          : `エラー: ${message}`;
        await postSystemAlert(
          `🔴 問い合わせ処理が失敗上限に達しました（id: ${inquiry.id}）\n本文冒頭: ${inquiry.body.slice(0, 50)}\n${reasonText}`,
        ).catch(() => {});
      }
    }
  }

  return NextResponse.json({
    ok: true,
    status: "processed",
    claimed: claimed.length,
    doneCount,
    retriedCount,
    failedCount,
  });
}
