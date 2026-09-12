// Supabase呼び出しの「一時的なDB不調」と「恒久的な設定ミス」を区別するためのヘルパー。
//
// 背景：cron-job.org から /api/cron/process の失敗メールが繰り返し届く問題を調査した結果、
// 原因はコードのバグではなくSupabase無料プランの一時的な Gateway Timeout だった
// （実測：直近22分で23回中4回、約17%）。1分毎の実行で成功と失敗が交互に起きるたびに
// 失敗通知メールが飛ぶため、「一時的な不調なら今回はスキップして200を返す」ようにしたい。
//
// ただし「一時的」の判定を誤ると、本当の障害（スキーマ設定ミス・キー失効等）まで
// 隠してしまう。判定は数値（HTTPステータス・PostgreSQLエラーコード）を基準にし、
// 判定できないものはすべて「恒久的（＝500を返す＝メールが飛ぶ）」に倒す。
// 迷ったら騒ぐ側に倒すのが、障害を隠さないための設計。

// Supabase(PostgREST)呼び出しの失敗を、判定に必要な情報を保持したまま表現するエラー型。
// supabase-js の { error, status } はそのまま呼び出し元で捨てられがちなので、
// throw する時点で status/code/details を持たせて運ぶ。
export class DbError extends Error {
  constructor(
    message: string,
    readonly status: number, // HTTPステータス。0 は通信自体が届かなかった場合（DNS失敗・タイムアウト打ち切り等）
    readonly code: string, // PostgreSQL/PostgREST のエラーコード。無いこともある
    readonly details: string, // 原因の詳細（ENOTFOUND 等はここに入る）
  ) {
    super(message);
    this.name = "DbError";
  }
}

// 一時的な不調（＝時間を置けば直る）を示すPostgreSQLエラーコード。
// 57014: statement timeout / 53300: too_many_connections / 40001,40P01: 競合・デッドロック
// 08006: 接続断
const TRANSIENT_PG_CODES = ["57014", "53300", "40001", "40P01", "08006"];

// URL設定ミスなど「時間を置いても直らない」通信断のパターン。
// status:0（通信自体が届かなかった）のときだけ見る。これに当たらなければ
// タイムアウト打ち切り・接続断など一時的なものとみなす。
const PERMANENT_CONNECTION_ERROR = /ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL/;

export function isTransientDbError(error: unknown): boolean {
  // DbError以外（想定していない形のエラー）は安全側に倒して恒久的とみなす
  if (!(error instanceof DbError)) return false;

  // 502/503/504 等、上流（PostgREST/ネットワーク経路）の一時的な不調。
  // 今回の本番エラー（Gateway Timeout = 504）はここに当たる。
  // 注：PostgRESTのスキーマキャッシュ未ロード時の503もここに含まれ一時的と判定するが、
  // それによりスキーマ再読込の恒久的な失敗が隠れる可能性は残る（daily-summaryの滞留監視で拾う）。
  if (error.status >= 500) return true;
  if (error.status === 408 || error.status === 429) return true;

  if (TRANSIENT_PG_CODES.includes(error.code)) return true;

  if (error.status === 0) {
    // 通信が届かなかったケース。名前解決できない＝設定ミスなので恒久扱いにする
    if (PERMANENT_CONNECTION_ERROR.test(error.details)) return false;
    // それ以外（8秒での打ち切り・接続断など）は一時的
    return true;
  }

  // その他の4xx（PGRST106のスキーマ設定ミス等）は恒久的
  return false;
}

interface WithRetryOptions {
  attempts?: number; // 最大試行回数（初回含む）
  baseDelayMs?: number; // 初回リトライまでの待ち時間。以降は倍々に増える
  deadlineMs?: number; // 全体の時間上限。これを超えたら残り試行を捨てて諦める
}

// 一時的なDB不調のときだけ、短く待ってその場で再試行するヘルパー。
//
// なぜ自前で用意したか：Supabase(postgrest-js)の内部リトライはGET/HEAD/OPTIONSの
// べき等なメソッドにしか効かない（RPC呼び出しはPOSTなので対象外）。
// claim_pending_inquiries 等のRPC呼び出しはPOSTのため、ライブラリ内部のリトライは
// 一切働かず、ここで包まない限り1回失敗しただけで即エラーになる。
//
// 全体デッドラインを設けているのは、Vercel Functionsの maxDuration（60秒）を
// 使い切ってVercel自身が504を返す事態を避けるため。504になるとステータスが
// 500→504に変わるだけで、cron-job.orgからの失敗メールは結局止まらない。
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const { attempts = 2, baseDelayMs = 500, deadlineMs = 15000 } = options;
  const startedAt = Date.now();

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === attempts;
      const elapsed = Date.now() - startedAt;
      if (
        isLastAttempt ||
        !isTransientDbError(error) ||
        elapsed >= deadlineMs
      ) {
        throw error;
      }

      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // ここには到達しない（attempts >= 1 なら必ず return か throw する）が、
  // 型チェッカーを満足させるために置いている
  throw lastError;
}
