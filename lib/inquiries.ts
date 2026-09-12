// inquiries テーブルへの投入・取得の共通ロジック

import { supabase } from "./supabase";
import { DbError, withRetry } from "./retry";
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
//
// 【DbErrorで throw する理由】supabase-js の戻り値には status（HTTPステータス）が
// 含まれているのに、通常の Error だとその情報が捨てられてしまう。呼び出し側
// （app/api/cron/process/route.ts）が「一時的なDB不調か、恒久的な設定ミスか」を
// 判定できるよう、DbError で status/code/details を運ぶ（lib/retry.ts 参照）。
export async function claimPendingInquiries(limit = 10): Promise<Inquiry[]> {
  const { error: reclaimError, status: reclaimStatus } = await supabase.rpc(
    "reclaim_stuck_inquiries",
  );
  if (reclaimError) {
    throw new DbError(
      `固着行の救済に失敗しました: ${reclaimError.message}`,
      reclaimStatus,
      reclaimError.code ?? "",
      reclaimError.details ?? "",
    );
  }

  const { data, error, status } = await supabase.rpc(
    "claim_pending_inquiries",
    {
      claim_limit: limit,
    },
  );
  if (error) {
    throw new DbError(
      `問い合わせの取得に失敗しました: ${error.message}`,
      status,
      error.code ?? "",
      error.details ?? "",
    );
  }
  return (data ?? []) as Inquiry[];
}

const MAX_RETRY_COUNT = 5;

// 【バグ修正】以前は processed_at が schema に存在しないままDB更新を試み、
// エラーも無視していたため、行が永久に processing→pending を繰り返す無限ループになっていた。
// schema.sql に processed_at を追加した上で、ここでもエラーを throw するようにした
// （throw すれば processOne の catch がリトライ処理に回してくれる）。
//
// withRetry で包んでいるのは、ここが一時的なDB不調で失敗すると「Slack/LINEへの通知は
// 送ったのに完了記録がDBに残らない」状態になり、次回のCronで再度通知が飛んでしまうため
// （updateInquirySlackInfo・markLineNotified も同じ理由でリトライしている）。
export async function markInquiryDone(id: string): Promise<void> {
  await withRetry(async () => {
    const { error, status } = await supabase
      .from("inquiries")
      .update({ status: "done", processed_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      throw new DbError(
        `処理完了の記録に失敗しました: ${error.message}`,
        status,
        error.code ?? "",
        error.details ?? "",
      );
    }
  });
}

// 失敗時：リトライ上限未満なら pending に戻して次回に再処理。
// 上限到達なら failed にして、呼び出し側でアラート送信する。
//
// isTransient（呼び出し側の isTransientDbError による判定）が true のときは、
// retry_count を消費せずに pending へ戻すだけにする。消費してしまうと、Supabaseの
// 一時的な不調が続く間にリトライ上限(5回)を使い切り、「本来なら普通に処理できたはずの
// 問い合わせ」が failed の墓場（README.md記載のとおり、二度と自動処理されない）に
// 入ってしまうため。ただし無限に据え置くとキューが詰まるので、受信から30分経っても
// 解決しない場合は諦めて failed にする（無限ループの歯止め）。
const TRANSIENT_GIVE_UP_MS = 30 * 60 * 1000;

export async function markInquiryFailedOrRetry(
  inquiry: Inquiry,
  options: { isTransient?: boolean } = {},
): Promise<{ willRetry: boolean }> {
  const tooOld =
    Date.now() - new Date(inquiry.received_at).getTime() > TRANSIENT_GIVE_UP_MS;

  if (options.isTransient && !tooOld) {
    const { error } = await supabase
      .from("inquiries")
      .update({ status: "pending", processing_started_at: null })
      .eq("id", inquiry.id);
    if (error) {
      console.error(
        `一時的エラーからの復帰処理に失敗しました（id: ${inquiry.id}）:`,
        error.message,
      );
      return { willRetry: false };
    }
    return { willRetry: true };
  }

  if (options.isTransient && tooOld) {
    // 一時的エラーが30分続いた＝DB自体が長期不調とみなし、無限に据え置かず failed にする
    const { error } = await supabase
      .from("inquiries")
      .update({ status: "failed", processing_started_at: null })
      .eq("id", inquiry.id);
    if (error) {
      console.error(
        `一時的エラーの長期化によるfailed化に失敗しました（id: ${inquiry.id}）:`,
        error.message,
      );
    }
    return { willRetry: false };
  }

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

// withRetryで包む理由は markInquiryDone のコメント参照
// （Slack投稿済みフラグの記録が失敗すると、次回のCronでSlackカードが二重投稿される）
export async function updateInquirySlackInfo(
  id: string,
  slackMessageTs: string,
  slackChannelId: string,
): Promise<void> {
  await withRetry(async () => {
    const { error, status } = await supabase
      .from("inquiries")
      .update({
        slack_message_ts: slackMessageTs,
        slack_channel_id: slackChannelId,
      })
      .eq("id", id);
    if (error) {
      throw new DbError(
        `Slack投稿情報の保存に失敗しました: ${error.message}`,
        status,
        error.code ?? "",
        error.details ?? "",
      );
    }
  });
}

// withRetryで包む理由は markInquiryDone のコメント参照
// （通知済みフラグの記録が失敗すると、次回のCronで部長のLINEに同じクレームが二重通知される）
export async function markLineNotified(id: string): Promise<void> {
  await withRetry(async () => {
    const { error, status } = await supabase
      .from("inquiries")
      .update({ line_notified_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      throw new DbError(
        `LINE通知済みの記録に失敗しました: ${error.message}`,
        status,
        error.code ?? "",
        error.details ?? "",
      );
    }
  });
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
