// LINE Webhook 受信エンドポイント
// 署名検証 → メッセージイベントを inquiries テーブルに投入する（キューに積むだけ。分類はしない）

import { NextRequest, NextResponse } from "next/server";
import {
  verifyLineSignature,
  getLineDisplayName,
  bodyForMessage,
} from "@/lib/line";
import { enqueueInquiry } from "@/lib/inquiries";
import type { LineWebhookEvent } from "@/lib/line";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");

  if (!verifyLineSignature(rawBody, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody) as { events?: LineWebhookEvent[] };
  const events = payload.events ?? [];

  for (const event of events) {
    // メッセージイベント以外（フォロー・アンフォロー等）は無視する
    if (event.type !== "message" || !event.message || !event.source?.userId)
      continue;

    const displayName =
      (await getLineDisplayName(event.source.userId)) ?? "LINEユーザー";
    const body = bodyForMessage(event.message);

    await enqueueInquiry({
      channel: "line",
      sender: displayName,
      body,
      receivedAt: new Date(event.timestamp),
      externalId: `line_${event.message.id}`,
    });
  }

  // LINE は200以外を返すとリトライしてくるため、処理中でも早めに200を返す
  return NextResponse.json({ ok: true });
}
