// Slack 連携：署名検証、通知カードの生成・投稿・更新、システムアラート送信

import crypto from "crypto";
import { CATEGORY_EMOJI, type Category, type Inquiry } from "./types";

const SLACK_API_BASE = "https://slack.com/api";

function botToken(): string {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN が設定されていません");
  return token;
}

// カテゴリごとの投稿先チャネルIDを取得する
export function channelIdForCategory(category: Category): string {
  const map: Record<Category, string | undefined> = {
    賃貸: process.env.SLACK_CHANNEL_RENTAL,
    売買: process.env.SLACK_CHANNEL_SALE,
    内見: process.env.SLACK_CHANNEL_VIEWING,
    クレーム: process.env.SLACK_CHANNEL_COMPLAINT,
    その他: process.env.SLACK_CHANNEL_OTHER,
  };
  const channelId = map[category];
  if (!channelId) {
    throw new Error(
      `カテゴリ「${category}」に対応する Slack チャネルIDが未設定です`,
    );
  }
  return channelId;
}

function systemAlertsChannelId(): string {
  const channelId = process.env.SLACK_CHANNEL_SYSTEM_ALERTS;
  if (!channelId)
    throw new Error("SLACK_CHANNEL_SYSTEM_ALERTS が設定されていません");
  return channelId;
}

// --- 署名検証 ---
// Slack はリクエストボディ全体の HMAC-SHA256 署名を X-Slack-Signature ヘッダーに付けてくる。
// 生のボディ文字列（パース前）に対して検証する必要があるため、呼び出し側は
// request.text() で読んだ生文字列をそのまま渡すこと。
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret || !timestamp || !signature) return false;

  // 5分以上古いリクエストはリプレイ攻撃の可能性があるため拒否
  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > fiveMinutes) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", signingSecret);
  hmac.update(baseString);
  const computedSignature = `v0=${hmac.digest("hex")}`;

  const a = Buffer.from(computedSignature);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- カテゴリ表示用の見出し（絵文字は lib/types.ts の CATEGORY_EMOJI を共有） ---
const STATUS_EMOJI = {
  unassigned: "🔴 未対応",
  assigned: "🟡 対応中",
  resolved: "✅ 対応済",
} as const;

function channelLabel(channel: Inquiry["channel"]): string {
  return channel === "gmail" ? "メール" : "LINE";
}

function senderLabel(inquiry: Inquiry): string {
  if (!inquiry.sender) return "不明";
  return inquiry.channel === "line"
    ? `${inquiry.sender}（LINE表示名）`
    : inquiry.sender;
}

function truncateBody(
  body: string,
  maxLength = 400,
): { shown: string; truncated: boolean } {
  if (body.length <= maxLength) return { shown: body, truncated: false };
  return { shown: body.slice(0, maxLength), truncated: true };
}

// 問い合わせ本文・送信者名など「外部から届く文字列」をSlackに載せる前に無害化する。
// Slackのmrkdwnでは <!channel> や <@Uxxxx> がチャンネル全員／特定個人への通知として
// 解釈されるため、エスケープしないと「本文に <!channel> と書くだけで全員に通知が飛ぶ」
// スパムの踏み台になる。Slack公式の推奨どおり & < > の3文字だけを実体参照に置換する
// （順序が重要：& を最初に置換しないと後段の &lt; などが二重エスケープされる）。
function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function statusText(inquiry: Inquiry): string {
  if (inquiry.resolved_at)
    return `${STATUS_EMOJI.resolved}（${inquiry.assigned_to ?? "担当者不明"}）`;
  if (inquiry.assigned_to)
    return `${STATUS_EMOJI.assigned}（担当：${inquiry.assigned_to}）`;
  return STATUS_EMOJI.unassigned;
}

// Slack の日時記法。閲覧者のタイムゾーン設定に合わせて自動表示されるため、
// サーバーが UTC で動いていても日本時間ズレの心配がない。
function slackDateToken(isoTimestamp: string): string {
  const unixSeconds = Math.floor(new Date(isoTimestamp).getTime() / 1000);
  const fallback = new Date(isoTimestamp).toISOString();
  return `<!date^${unixSeconds}^{date_short_pretty} {time}|${fallback}>`;
}

interface BuildCardResult {
  blocks: unknown[];
  attachmentColor?: string;
  headerText: string;
}

function buildCardContent(inquiry: Inquiry): BuildCardResult {
  const isComplaint = inquiry.category === "クレーム";
  const emoji = inquiry.category ? CATEGORY_EMOJI[inquiry.category] : "📩";
  const headerText = isComplaint
    ? "🚨 クレーム発生"
    : `${emoji} 新着問い合わせ（${inquiry.category ?? "分類中"}）`;
  const { shown, truncated } = truncateBody(inquiry.body);

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText, emoji: true },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: statusText(inquiry) }],
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*経路:*\n${channelLabel(inquiry.channel)}` },
        {
          type: "mrkdwn",
          text: `*送信者:*\n${escapeSlackText(senderLabel(inquiry))}`,
        },
        {
          type: "mrkdwn",
          text: `*受信:*\n${slackDateToken(inquiry.received_at)}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncated
          ? `${escapeSlackText(shown)}\n_…（続きあり。スレッドに全文を投稿）_`
          : escapeSlackText(shown),
      },
    },
    {
      type: "actions",
      block_id: `inquiry_actions_${inquiry.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "担当になる", emoji: true },
          style: "primary",
          action_id: "assign_inquiry",
          value: inquiry.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "対応済にする", emoji: true },
          action_id: "resolve_inquiry",
          value: inquiry.id,
          confirm: {
            title: { type: "plain_text", text: "対応済にしますか？" },
            text: {
              type: "mrkdwn",
              text: "この問い合わせを対応済にします。一覧から消え、担当者以外は気づけなくなります。よろしいですか？",
            },
            confirm: { type: "plain_text", text: "対応済にする" },
            deny: { type: "plain_text", text: "キャンセル" },
          },
        },
      ],
    },
  ];

  return {
    blocks,
    attachmentColor: isComplaint ? "#E01E5A" : undefined,
    headerText,
  };
}

interface SlackPostResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

async function slackApiCall<T = Record<string, unknown>>(
  method: string,
  body: Record<string, unknown>,
): Promise<T & { ok: boolean; error?: string }> {
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken()}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return response.json();
}

// 新規カードを投稿する。クレームの場合は attachments でカラーバー(赤)を付け、
// @channel メンションで全員に通知する。
export async function postInquiryCard(
  inquiry: Inquiry,
): Promise<SlackPostResult> {
  const channelId = channelIdForCategory(inquiry.category ?? "その他");
  const { blocks, attachmentColor } = buildCardContent(inquiry);
  const isComplaint = inquiry.category === "クレーム";

  const payload: Record<string, unknown> = isComplaint
    ? {
        channel: channelId,
        text: "🚨 クレームが発生しました",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "<!channel>" } },
        ],
        attachments: [{ color: attachmentColor, blocks }],
      }
    : {
        channel: channelId,
        text: "新着問い合わせがあります",
        blocks,
      };

  const result = await slackApiCall<SlackPostResult>(
    "chat.postMessage",
    payload,
  );

  // 本文が長い場合は全文をスレッドに投稿する
  const { truncated } = truncateBody(inquiry.body);
  if (result.ok && result.ts && truncated) {
    await slackApiCall("chat.postMessage", {
      channel: channelId,
      thread_ts: result.ts,
      text: escapeSlackText(inquiry.body),
    });
  }

  return { ...result, channel: channelId };
}

// ボタン操作後にカードを更新する（担当決定・対応済み）
export async function updateInquiryCard(
  inquiry: Inquiry,
): Promise<SlackPostResult> {
  if (!inquiry.slack_channel_id || !inquiry.slack_message_ts) {
    throw new Error("更新対象のSlackメッセージ情報がありません");
  }
  const { blocks, attachmentColor } = buildCardContent(inquiry);
  const isComplaint = inquiry.category === "クレーム";

  const payload: Record<string, unknown> = isComplaint
    ? {
        channel: inquiry.slack_channel_id,
        ts: inquiry.slack_message_ts,
        text: "🚨 クレームが発生しました",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "<!channel>" } },
        ],
        attachments: [{ color: attachmentColor, blocks }],
      }
    : {
        channel: inquiry.slack_channel_id,
        ts: inquiry.slack_message_ts,
        text: "問い合わせ",
        blocks,
      };

  return slackApiCall<SlackPostResult>("chat.update", payload);
}

// 部長へのLINE通知にSlackカードへのリンクを添えるためのpermalink取得
export async function getPermalink(
  channel: string,
  messageTs: string,
): Promise<string | null> {
  const result = await slackApiCall<{ permalink?: string }>(
    "chat.getPermalink",
    {
      channel,
      message_ts: messageTs,
    },
  );
  return result.ok ? (result.permalink ?? null) : null;
}

// システム系アラート（処理失敗・日次サマリ）を専用チャネルへ投稿
export async function postSystemAlert(text: string): Promise<void> {
  await slackApiCall("chat.postMessage", {
    channel: systemAlertsChannelId(),
    text,
  });
}

// 誰がボタンを押したかを ephemeral（本人だけに見える）メッセージで伝える
export async function postEphemeral(
  channel: string,
  userId: string,
  text: string,
): Promise<void> {
  await slackApiCall("chat.postEphemeral", { channel, user: userId, text });
}
