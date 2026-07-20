// 営業部長の個人LINEに届く通知の見た目を再現するプレビュー。
// lib/line.ts の notifyManagerOfComplaint と文面構成を揃えている。
//
// クレーム以外では通知自体を送らない設計（オオカミ少年化防止）。
// これは欠落ではなく設計意図なので、「✓ 通知していません」として
// 積極的に見せる（消してしまうと機能の存在が伝わらないため）。

interface LinePreviewProps {
  isUrgent: boolean;
  body: string;
  onTryComplaintSample: () => void;
}

function excerpt(body: string, maxLength = 150): string {
  return body.length > maxLength ? `${body.slice(0, maxLength)}…` : body;
}

export function LinePreview({
  isUrgent,
  body,
  onTryComplaintSample,
}: LinePreviewProps) {
  if (!isUrgent) {
    return (
      <div className="rounded-lg border border-navy-200 bg-navy-50 p-5">
        <p className="text-sm font-semibold text-navy-900">
          ✓ 通知していません
        </p>
        <p className="mt-2 text-sm text-navy-700">
          LINE通知はクレーム判定時のみ送ります。通常の問い合わせで部長のスマホを鳴らすと、
          本当に緊急な時に気づかれなくなるためです。
        </p>
        <button
          type="button"
          onClick={onTryComplaintSample}
          className="mt-3 text-sm font-semibold text-blue-600 hover:underline"
        >
          → クレームのサンプルを試す
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-sm rounded-2xl border border-green-200 bg-white p-4 shadow-sm">
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-navy-900">
        {"🚨クレーム検知：山田太郎様（LINE経由）\n"}
        {"────────────\n"}
        {`「${excerpt(body)}」\n`}
        {"────────────\n"}
        {"受信：たった今\n"}
      </p>
      <p className="mt-1 text-sm">
        <span className="text-navy-500">
          ▼Slackで詳細・対応状況を見る{"\n"}
        </span>
        <span className="cursor-not-allowed text-blue-600 opacity-60">
          https://xxx.slack.com/archives/…
        </span>
      </p>
      <p className="mt-2 text-xs text-navy-500">※AIによる自動判定です</p>
    </div>
  );
}
