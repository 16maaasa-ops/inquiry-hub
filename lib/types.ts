// アプリ全体で共有する型定義

export type Channel = "gmail" | "line";

export type Category = "賃貸" | "売買" | "内見" | "クレーム" | "その他";

export const CATEGORIES: Category[] = [
  "賃貸",
  "売買",
  "内見",
  "クレーム",
  "その他",
];

// カテゴリ別の絵文字。lib/slack.ts のカード生成とデモ画面のプレビューで共有する。
export const CATEGORY_EMOJI: Record<Category, string> = {
  賃貸: "🏠",
  売買: "💰",
  内見: "📅",
  クレーム: "🚨",
  その他: "📮",
};

export type InquiryStatus =
  "pending" | "processing" | "done" | "failed" | "skipped";

export interface Inquiry {
  id: string;
  channel: Channel;
  sender: string | null;
  body: string;
  received_at: string;
  category: Category | null;
  is_urgent: boolean;
  reason: string | null;
  status: InquiryStatus;
  retry_count: number;
  processing_started_at: string | null;
  processed_at: string | null;
  slack_message_ts: string | null;
  slack_channel_id: string | null;
  line_notified_at: string | null;
  assigned_to: string | null;
  resolved_at: string | null;
  external_id: string | null;
  created_at: string;
}
