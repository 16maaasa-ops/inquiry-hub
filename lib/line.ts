// LINE 連携：Webhook署名検証、部長への緊急Push通知

import crypto from "crypto";
import type { Inquiry } from "./types";

const LINE_API_BASE = "https://api.line.me/v2/bot";

function channelAccessToken(): string {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません");
  return token;
}

// --- Webhook 署名検証 ---
// LINE はリクエストボディのHMAC-SHA256署名（Base64）を X-Line-Signature ヘッダーに付ける。
// 生のボディ文字列に対して検証する必要がある。
export function verifyLineSignature(
  rawBody: string,
  signature: string | null,
): boolean {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!channelSecret || !signature) return false;

  const hmac = crypto.createHmac("sha256", channelSecret);
  hmac.update(rawBody);
  const computedSignature = hmac.digest("base64");

  const a = Buffer.from(computedSignature);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// LINE Webhook のイベント型（最小限）
export interface LineWebhookEvent {
  type: string;
  message?: {
    id: string;
    type: string; // 'text' | 'image' | 'sticker' | ...
    text?: string;
  };
  source?: {
    userId?: string;
  };
  timestamp: number;
  replyToken?: string;
}

// LINE表示名を取得する（プロフィールAPI）。取得できなければ null。
export async function getLineDisplayName(
  userId: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${LINE_API_BASE}/profile/${userId}`, {
      headers: { Authorization: `Bearer ${channelAccessToken()}` },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { displayName?: string };
    return data.displayName ?? null;
  } catch {
    return null;
  }
}

// テキスト以外のメッセージ種別を固定文言に変換する
export function bodyForMessage(message: LineWebhookEvent["message"]): string {
  if (!message) return "[内容を取得できませんでした]";
  if (message.type === "text" && message.text) return message.text;
  if (message.type === "image")
    return "[画像が届きました。LINEアプリで内容を確認してください]";
  if (message.type === "sticker")
    return "[スタンプが届きました。LINEアプリで内容を確認してください]";
  return `[${message.type} が届きました。LINEアプリで内容を確認してください]`;
}

// 部長個人LINEへクレームを即時通知する。
// ロック画面のプレビューは先頭1〜2行しか出ないため、1行目に「誰から・どこから」を凝縮する。
export async function notifyManagerOfComplaint(
  inquiry: Inquiry,
  slackPermalink: string | null,
): Promise<void> {
  const managerUserId = process.env.LINE_MANAGER_USER_ID;
  if (!managerUserId)
    throw new Error("LINE_MANAGER_USER_ID が設定されていません");

  const senderLabel = inquiry.sender ?? "送信者不明";
  const channelLabel = inquiry.channel === "gmail" ? "メール経由" : "LINE経由";
  const excerpt =
    inquiry.body.length > 150 ? `${inquiry.body.slice(0, 150)}…` : inquiry.body;
  const receivedAt = new Date(inquiry.received_at).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const lines = [
    `🚨クレーム検知：${senderLabel}様（${channelLabel}）`,
    "────────────",
    `「${excerpt}」`,
    "────────────",
    `受信：${receivedAt}`,
  ];
  if (slackPermalink) {
    lines.push("▼Slackで詳細・対応状況を見る", slackPermalink);
  }
  lines.push("※AIによる自動判定です");

  const text = lines.join("\n");

  const response = await fetch(`${LINE_API_BASE}/message/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${channelAccessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: managerUserId,
      messages: [{ type: "text", text }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `LINE Push 送信に失敗しました: ${response.status} ${errorBody}`,
    );
  }
}
