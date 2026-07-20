// キュー処理ワーカー Cron（1分間隔）
//
// 処理の流れ（1件ごと）：
//   1. 固着行の救済（claimPendingInquiries 内で実行）
//   2. pending をアトミックに取得（SKIP LOCKED で二重処理を防止）
//   3. 分類（未分類なら）→ Slack投稿（未投稿なら）→ クレームならLINE通知（未通知なら）
//   4. 成功: done / 失敗: リトライ upper下ならpendingに戻す、上限到達ならfailed+アラート
//
// 各ステップは「既にやったこと」をDBの列で判定してスキップするため、
// リトライで同じ通知が2回飛ぶことはない（冪等性）。

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

  const claimed = await claimPendingInquiries(10);

  let doneCount = 0;
  let failedCount = 0;

  for (const inquiry of claimed) {
    try {
      await processOne(inquiry);
      doneCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { willRetry } = await markInquiryFailedOrRetry(inquiry);
      if (!willRetry) {
        failedCount += 1;
        await postSystemAlert(
          `🔴 問い合わせ処理が失敗上限に達しました（id: ${inquiry.id}）\n本文冒頭: ${inquiry.body.slice(0, 50)}\nエラー: ${message}`,
        ).catch(() => {});
      }
    }
  }

  return NextResponse.json({
    ok: true,
    claimed: claimed.length,
    doneCount,
    failedCount,
  });
}
