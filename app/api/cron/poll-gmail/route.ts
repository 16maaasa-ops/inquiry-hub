// Gmail ポーリング Cron（1分間隔）
// 前回取得時刻より少し前以降に届いたメールを取得し、キューに投入する（未読フラグは使わない）

import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { fetchRecentInquiries } from "@/lib/gmail";
import { enqueueInquiry } from "@/lib/inquiries";
import { postSystemAlert } from "@/lib/slack";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const { inquiries, skippedNoreply } = await fetchRecentInquiries();

    let insertedCount = 0;
    for (const inquiry of inquiries) {
      const { inserted } = await enqueueInquiry({
        channel: "gmail",
        sender: inquiry.sender,
        body: inquiry.body,
        receivedAt: inquiry.receivedAt,
        externalId: inquiry.externalId,
      });
      if (inserted) insertedCount += 1;
    }

    return NextResponse.json({ ok: true, insertedCount, skippedNoreply });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Gmail認証エラー等はここに来る。静かに止まると気づけないため必ずアラートを飛ばす。
    await postSystemAlert(
      `⚠️ Gmail ポーリングでエラーが発生しました:\n${message}`,
    ).catch(() => {});
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
