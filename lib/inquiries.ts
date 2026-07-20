// inquiries テーブルへの投入・取得の共通ロジック

import { supabase } from "./supabase";
import type { Channel, Inquiry } from "./types";

export interface NewInquiry {
  channel: Channel;
  sender: string;
  body: string;
  receivedAt: Date;
  externalId: string;
}

// external_id が重複する場合は何もしない（LINEの再送・Gmailの重複取得を吸収する）
export async function enqueueInquiry(
  input: NewInquiry,
): Promise<{ inserted: boolean }> {
  const { error, count } = await supabase.from("inquiries").upsert(
    {
      channel: input.channel,
      sender: input.sender,
      body: input.body,
      received_at: input.receivedAt.toISOString(),
      external_id: input.externalId,
      status: "pending",
    },
    { onConflict: "external_id", ignoreDuplicates: true, count: "exact" },
  );

  if (error) {
    throw new Error(`問い合わせの登録に失敗しました: ${error.message}`);
  }
  return { inserted: (count ?? 0) > 0 };
}

// 固着行を救済してから、pending をアトミックに取得する（二重処理防止）
export async function claimPendingInquiries(limit = 10): Promise<Inquiry[]> {
  const { error: reclaimError } = await supabase.rpc("reclaim_stuck_inquiries");
  if (reclaimError) {
    throw new Error(`固着行の救済に失敗しました: ${reclaimError.message}`);
  }

  const { data, error } = await supabase.rpc("claim_pending_inquiries", {
    claim_limit: limit,
  });
  if (error) {
    throw new Error(`問い合わせの取得に失敗しました: ${error.message}`);
  }
  return (data ?? []) as Inquiry[];
}

const MAX_RETRY_COUNT = 5;

// 【バグ修正】以前は processed_at が schema に存在しないままDB更新を試み、
// エラーも無視していたため、行が永久に processing→pending を繰り返す無限ループになっていた。
// schema.sql に processed_at を追加した上で、ここでもエラーを throw するようにした
// （throw すれば processOne の catch がリトライ処理に回してくれる）。
export async function markInquiryDone(id: string): Promise<void> {
  const { error } = await supabase
    .from("inquiries")
    .update({ status: "done", processed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    throw new Error(`処理完了の記録に失敗しました: ${error.message}`);
  }
}

// 失敗時：リトライ上限未満なら pending に戻して次回に再処理。
// 上限到達なら failed にして、呼び出し側でアラート送信する。
export async function markInquiryFailedOrRetry(
  inquiry: Inquiry,
): Promise<{ willRetry: boolean }> {
  const nextRetryCount = inquiry.retry_count + 1;
  const willRetry = nextRetryCount < MAX_RETRY_COUNT;

  const { error } = await supabase
    .from("inquiries")
    .update({
      status: willRetry ? "pending" : "failed",
      retry_count: nextRetryCount,
      processing_started_at: null,
    })
    .eq("id", inquiry.id);

  if (error) {
    // ここでの更新失敗はリトライ記録そのものが残らない事態。これ以上ラップする再試行経路が
    // ないため、呼び出し側に「上限到達（＝アラート送信）」として扱わせる。
    console.error(
      `リトライ状態の更新に失敗しました（id: ${inquiry.id}）:`,
      error.message,
    );
    return { willRetry: false };
  }

  return { willRetry };
}

export async function updateInquiryClassification(
  id: string,
  category: string,
  isUrgent: boolean,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from("inquiries")
    .update({ category, is_urgent: isUrgent, reason })
    .eq("id", id);
  if (error) {
    throw new Error(`分類結果の保存に失敗しました: ${error.message}`);
  }
}

export async function updateInquirySlackInfo(
  id: string,
  slackMessageTs: string,
  slackChannelId: string,
): Promise<void> {
  const { error } = await supabase
    .from("inquiries")
    .update({
      slack_message_ts: slackMessageTs,
      slack_channel_id: slackChannelId,
    })
    .eq("id", id);
  if (error) {
    throw new Error(`Slack投稿情報の保存に失敗しました: ${error.message}`);
  }
}

export async function markLineNotified(id: string): Promise<void> {
  const { error } = await supabase
    .from("inquiries")
    .update({ line_notified_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    throw new Error(`LINE通知済みの記録に失敗しました: ${error.message}`);
  }
}

export async function getInquiryById(id: string): Promise<Inquiry | null> {
  const { data, error } = await supabase
    .from("inquiries")
    .select("*")
    .eq("id", id)
    .single();
  if (error) return null;
  return data as Inquiry;
}

export async function assignInquiry(
  id: string,
  assignedTo: string,
): Promise<Inquiry | null> {
  const { data, error } = await supabase
    .from("inquiries")
    .update({ assigned_to: assignedTo })
    .eq("id", id)
    .is("assigned_to", null) // 既に担当者がいる場合は上書きしない
    .select()
    .single();
  if (error) return null;
  return data as Inquiry;
}

export async function resolveInquiry(
  id: string,
  resolvedBy: string,
): Promise<Inquiry | null> {
  const { data, error } = await supabase
    .from("inquiries")
    .update({ resolved_at: new Date().toISOString(), assigned_to: resolvedBy })
    .eq("id", id)
    .select()
    .single();
  if (error) return null;
  return data as Inquiry;
}
