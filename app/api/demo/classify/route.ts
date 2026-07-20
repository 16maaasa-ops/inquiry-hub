// デモ画面用の分類エンドポイント。
//
// 重要: このルートは ANTHROPIC_API_KEY だけで動く。DB・Slack・LINEには一切触らない
// （副作用ゼロ設計）。誰でもアクセスできる公開エンドポイントのため、
// 入力バリデーションとレート制限で悪用・コスト暴走を防いでいる。
// 最終防波堤は Anthropic Console 側で設定する月額支出上限（コードでは対策しきれない）。

import { NextRequest, NextResponse } from "next/server";
import { classifyInquiry } from "@/lib/claude";
import { isRateLimited } from "@/lib/rate-limit";
import { MAX_BODY_LENGTH } from "@/lib/samples";

function getClientIdentifier(request: NextRequest): string {
  // Vercelはプロキシ経由でリクエストが来るため x-forwarded-for を見る
  const forwardedFor = request.headers.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() ?? "unknown";
}

export async function POST(request: NextRequest) {
  const identifier = getClientIdentifier(request);
  if (isRateLimited(identifier)) {
    return NextResponse.json(
      { error: "アクセスが集中しています。30秒ほどおいてからお試しください。" },
      { status: 429 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "リクエストの形式が正しくありません。" },
      { status: 400 },
    );
  }

  const body = (payload as { body?: unknown } | null)?.body;

  if (typeof body !== "string") {
    return NextResponse.json(
      { error: "本文は文字列で入力してください。" },
      { status: 400 },
    );
  }

  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return NextResponse.json(
      { error: "本文を入力してください。" },
      { status: 400 },
    );
  }

  if (trimmed.length > MAX_BODY_LENGTH) {
    return NextResponse.json(
      {
        error: `本文は${MAX_BODY_LENGTH}字以内で入力してください（現在${trimmed.length}字）。`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await classifyInquiry(trimmed);
    return NextResponse.json(result);
  } catch (error) {
    console.error("デモ分類でエラーが発生しました:", error);
    return NextResponse.json(
      {
        error:
          "AIの判定に失敗しました。少し時間をおいて、もう一度お試しください。",
      },
      { status: 502 },
    );
  }
}
