// Slackに実際に投稿されるカードの見た目を再現するプレビュー。
// lib/slack.ts の buildCardContent / postInquiryCard と見た目を揃えている。
//
// 「額縁方式」: カードの中は実物に忠実に再現し、「これは見本です」という注記は
// 呼び出し側（app/page.tsx）でこのコンポーネントの外側に置く。カードの中に
// 注記を混ぜると再現度が落ちるため、ここでは一切書かない。
//
// ボタンは押せない外観にする（本物そっくりに描くと人は押してしまい、
// 押しても何も起きないと「壊れている」と受け取られるため）。

import { CATEGORY_EMOJI, type Category } from "@/lib/types";

interface SlackCardPreviewProps {
  category: Category;
  body: string;
}

function truncateBody(
  body: string,
  maxLength = 400,
): { shown: string; truncated: boolean } {
  if (body.length <= maxLength) return { shown: body, truncated: false };
  return { shown: body.slice(0, maxLength), truncated: true };
}

export function SlackCardPreview({ category, body }: SlackCardPreviewProps) {
  const isComplaint = category === "クレーム";
  const emoji = CATEGORY_EMOJI[category];
  const headerText = isComplaint
    ? "🚨 クレーム発生"
    : `${emoji} 新着問い合わせ（${category}）`;
  const { shown, truncated } = truncateBody(body);

  return (
    <div className="space-y-2">
      {/* @channel は実装（lib/slack.ts）ではカードの外側に投稿される */}
      {isComplaint && (
        <p className="text-sm font-semibold text-navy-700">
          <span className="rounded bg-navy-100 px-1.5 py-0.5">@channel</span>
        </p>
      )}
      <div
        className="overflow-hidden rounded-lg border border-navy-200 bg-white shadow-sm"
        style={
          isComplaint
            ? { borderLeft: "4px solid var(--color-alert)" }
            : undefined
        }
      >
        <div className="space-y-3 p-4">
          <p className="text-base font-bold text-navy-900">{headerText}</p>
          <p className="text-xs font-medium text-navy-500">🔴 未対応</p>
          <div className="grid grid-cols-3 gap-3 text-xs text-navy-700">
            <div>
              <p className="font-semibold">経路</p>
              <p>LINE</p>
            </div>
            <div>
              <p className="font-semibold">送信者</p>
              <p>山田太郎 様（サンプル）</p>
            </div>
            <div>
              <p className="font-semibold">受信</p>
              <p>たった今</p>
            </div>
          </div>
          <p className="whitespace-pre-wrap text-sm text-navy-900">
            {shown}
            {truncated && (
              <span className="text-navy-500">
                {"\n"}…（続きあり。スレッドに全文を投稿）
              </span>
            )}
          </p>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled
              className="cursor-not-allowed rounded border border-blue-600 bg-blue-600/60 px-3 py-1.5 text-xs font-semibold text-white opacity-60"
            >
              担当になる
            </button>
            <button
              type="button"
              disabled
              className="cursor-not-allowed rounded border border-navy-200 bg-white px-3 py-1.5 text-xs font-semibold text-navy-700 opacity-60"
            >
              対応済にする
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
