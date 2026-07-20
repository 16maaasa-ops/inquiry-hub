// 公開デモエンドポイント用の簡易レート制限（IPごとにメモリ上でカウント）。
// サーバーレス環境ではインスタンスごとにメモリが分かれるため完璧ではないが、
// 素朴な連打・自動化スクリプトを止める効果はある。Claude APIの支出上限設定と
// 合わせて多層防御の1枚として使う。

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;

const requestLog = new Map<string, number[]>();

export function isRateLimited(identifier: string): boolean {
  const now = Date.now();
  const timestamps = requestLog.get(identifier) ?? [];
  const recent = timestamps.filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    requestLog.set(identifier, recent);
    return true;
  }

  recent.push(now);
  requestLog.set(identifier, recent);
  return false;
}
