// Vercel Cron からの呼び出しであることを確認するためのヘルパー。
// Vercel は Cron 実行時に Authorization: Bearer <CRON_SECRET> ヘッダーを自動で付与する。
// これが無い/一致しないリクエストは、URLを知っているだけの第三者からの不正な呼び出しとみなして拒否する。

import { NextRequest } from "next/server";

export function isAuthorizedCronRequest(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // 環境変数未設定は設定ミス。安全側に倒して拒否する。
    return false;
  }
  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${cronSecret}`;
}
