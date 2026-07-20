// Gmail 連携：時刻ベースのポーリング取得
//
// 「未読メール」を目印にすると、ポーリングより先に人間がGmail上で開封した瞬間に
// システムからは見えなくなってしまう（取りこぼしの原因）。
// そのため「前回取得時刻より少し前（余裕を見て）以降に届いたメール」を毎回検索し、
// external_id（GmailメッセージID）で重複を弾く方式にしている。既読化も行わない。

import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";

const NOREPLY_PATTERNS = [/no-?reply/i, /do-?not-?reply/i, /mailer-daemon/i];

function getGmailClient() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Gmail の環境変数が設定されていません（GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN）",
    );
  }
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

export interface GmailInquiry {
  externalId: string;
  sender: string;
  body: string;
  receivedAt: Date;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// メール本文パートを再帰的に探す。text/plain を優先し、無ければ text/html をタグ除去する。
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  function findPart(
    part: gmail_v1.Schema$MessagePart,
    mimeType: string,
  ): gmail_v1.Schema$MessagePart | null {
    if (part.mimeType === mimeType && part.body?.data) return part;
    for (const child of part.parts ?? []) {
      const found = findPart(child, mimeType);
      if (found) return found;
    }
    return null;
  }

  const plainPart = findPart(payload, "text/plain");
  if (plainPart?.body?.data) {
    return decodeBase64Url(plainPart.body.data).slice(0, 1000);
  }

  const htmlPart = findPart(payload, "text/html");
  if (htmlPart?.body?.data) {
    return stripHtml(decodeBase64Url(htmlPart.body.data)).slice(0, 1000);
  }

  // シングルパートのメール
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    return (
      payload.mimeType === "text/html" ? stripHtml(decoded) : decoded
    ).slice(0, 1000);
  }

  return "[本文を取得できませんでした]";
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

function isNoreply(fromHeader: string): boolean {
  return NOREPLY_PATTERNS.some((pattern) => pattern.test(fromHeader));
}

// sinceMinutesAgo: この分数より新しいメールだけを取得する。
// Cronは1分間隔だが、遅延や再起動時の取りこぼしを避けるため余裕を持たせている。
export async function fetchRecentInquiries(sinceMinutesAgo = 6): Promise<{
  inquiries: GmailInquiry[];
  skippedNoreply: number;
}> {
  const gmail = getGmailClient();
  const sinceEpochSeconds =
    Math.floor(Date.now() / 1000) - sinceMinutesAgo * 60;
  const query = `after:${sinceEpochSeconds} -in:chats`;

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 30,
  });
  const messageRefs = listRes.data.messages ?? [];

  const inquiries: GmailInquiry[] = [];
  let skippedNoreply = 0;

  for (const ref of messageRefs) {
    if (!ref.id) continue;
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: ref.id,
      format: "full",
    });
    const headers = detail.data.payload?.headers ?? undefined;
    const fromHeader = getHeader(headers, "From");

    if (isNoreply(fromHeader)) {
      skippedNoreply += 1;
      continue;
    }

    const body = extractBody(detail.data.payload);
    const internalDate = detail.data.internalDate
      ? new Date(Number(detail.data.internalDate))
      : new Date();

    inquiries.push({
      externalId: `gmail_${detail.data.id}`,
      sender: fromHeader || "不明",
      body,
      receivedAt: internalDate,
    });
  }

  return { inquiries, skippedNoreply };
}
