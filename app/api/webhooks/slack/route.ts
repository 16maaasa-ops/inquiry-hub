// Slack Interactivity（ボタン操作）受信エンドポイント
// 署名検証 → 「担当になる」「対応済にする」の操作を処理する
//
// Slack はボタン押下から3秒以内の応答を求める。このルートはDB更新1回 + Slack API呼び出し1回
// という軽い処理のみを行い、同期的に完結させることで3秒制限を守っている。

import { NextRequest, NextResponse } from "next/server";
import {
  verifySlackSignature,
  updateInquiryCard,
  postEphemeral,
} from "@/lib/slack";
import { getInquiryById, assignInquiry, resolveInquiry } from "@/lib/inquiries";

interface SlackInteractionPayload {
  type: string;
  user: { id: string; username?: string; name?: string };
  channel: { id: string };
  actions: { action_id: string; value: string }[];
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // Slack Interactivity は application/x-www-form-urlencoded で payload=<JSON> を送ってくる
  const params = new URLSearchParams(rawBody);
  const payloadJson = params.get("payload");
  if (!payloadJson) {
    return NextResponse.json({ error: "missing payload" }, { status: 400 });
  }

  const payload = JSON.parse(payloadJson) as SlackInteractionPayload;
  if (payload.type !== "block_actions" || payload.actions.length === 0) {
    return NextResponse.json({ ok: true });
  }

  const action = payload.actions[0];
  const inquiryId = action.value;
  const actorName =
    payload.user.username ?? payload.user.name ?? "不明なユーザー";

  const inquiry = await getInquiryById(inquiryId);
  if (!inquiry) {
    return NextResponse.json({ error: "inquiry not found" }, { status: 404 });
  }

  if (action.action_id === "assign_inquiry") {
    const updated = await assignInquiry(inquiryId, actorName);
    if (!updated) {
      // 既に担当者がいる場合（他の人が先に押した）：本人だけに見えるメッセージで伝える
      const current = await getInquiryById(inquiryId);
      await postEphemeral(
        payload.channel.id,
        payload.user.id,
        `既に ${current?.assigned_to ?? "他の担当者"} さんが担当しています。`,
      );
      return NextResponse.json({ ok: true });
    }
    await updateInquiryCard(updated);
  } else if (action.action_id === "resolve_inquiry") {
    const updated = await resolveInquiry(inquiryId, actorName);
    if (updated) {
      await updateInquiryCard(updated);
    }
  }

  return NextResponse.json({ ok: true });
}
