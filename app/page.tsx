"use client";

import { useRef, useState } from "react";
import { SlackCardPreview } from "@/components/SlackCardPreview";
import { LinePreview } from "@/components/LinePreview";
import {
  SAMPLES,
  DEFAULT_SAMPLE,
  MAX_BODY_LENGTH,
  type Sample,
} from "@/lib/samples";
import { CATEGORY_EMOJI, type Category } from "@/lib/types";

interface ClassifyResult {
  category: Category;
  isUrgent: boolean;
  reason: string;
}

export default function Home() {
  const [text, setText] = useState(DEFAULT_SAMPLE.body);
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(
    DEFAULT_SAMPLE.id,
  );
  const [result, setResult] = useState<ClassifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const trimmedLength = text.trim().length;
  const isOverLimit = trimmedLength > MAX_BODY_LENGTH;
  const isEmpty = trimmedLength === 0;
  const canSubmit = !isEmpty && !isOverLimit && !loading;

  const selectedSample = SAMPLES.find((s) => s.id === selectedSampleId);

  function handleSampleClick(sample: Sample) {
    setText(sample.body);
    setSelectedSampleId(sample.id);
    setResult(null);
    setError(null);
  }

  function handleTextChange(value: string) {
    setText(value);
    setSelectedSampleId(null);
  }

  function handleClear() {
    setText("");
    setSelectedSampleId(null);
    setResult(null);
    setError(null);
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/demo/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          data.error ??
            "AIの判定に失敗しました。少し時間をおいて、もう一度お試しください。",
        );
        return;
      }
      setResult(data);
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    } catch {
      setError(
        "通信に失敗しました。ネットワーク接続を確認し、もう一度お試しください。",
      );
    } finally {
      setLoading(false);
    }
  }

  const counterColor = isOverLimit
    ? "text-red-600"
    : trimmedLength > 900
      ? "text-orange-500"
      : "text-navy-500";

  return (
    <main className="min-h-screen bg-white text-navy-900">
      {/* ヒーロー */}
      <section className="bg-navy-900 px-6 py-16 text-white">
        <div className="mx-auto max-w-[720px]">
          <h1 className="text-3xl leading-snug font-bold md:text-4xl">
            問い合わせ集約 + AI分類システム
          </h1>
          <p className="mt-4 text-base leading-relaxed text-navy-100 md:text-lg">
            Gmail・LINEに届く問い合わせをSlackに自動集約。AIが賃貸・売買・内見・クレームの4つに分類し、
            当てはまらないものは「その他」として取りこぼさず受け止めます。
            クレームだけは5分以内に営業部長のLINEへ直接通知します。
          </p>
        </div>
      </section>

      {/* 仕組み図（PCは横フロー、スマホは縦積み） */}
      <section className="bg-navy-50 px-6 py-16">
        <div className="mx-auto max-w-[720px]">
          <h2 className="text-xl font-bold md:text-2xl">仕組み</h2>
          <div className="mt-8 flex flex-col items-center gap-3 md:flex-row md:justify-center md:gap-4">
            <div className="flex gap-3">
              <FlowBox label="Gmail" />
              <FlowBox label="LINE" />
            </div>
            <Arrow />
            <FlowBox label="AI分類" highlight />
            <Arrow />
            <div className="flex flex-col gap-3 md:flex-row">
              <FlowBox label="Slack" />
              <FlowBox label="部長LINE（クレーム時）" />
            </div>
          </div>
        </div>
      </section>

      {/* 試してみる */}
      <section className="bg-white px-6 py-16">
        <div className="mx-auto max-w-[720px]">
          <h2 className="text-xl font-bold md:text-2xl">試してみる</h2>
          <p className="mt-2 text-sm text-navy-700">
            実際の問い合わせ例で試せます
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            {SAMPLES.map((sample) => (
              <button
                key={sample.id}
                type="button"
                onClick={() => handleSampleClick(sample)}
                className={`min-h-[44px] rounded-full border px-4 py-2 text-sm font-medium transition ${
                  selectedSampleId === sample.id
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-navy-200 bg-white text-navy-700 hover:border-blue-600"
                }`}
              >
                {sample.label}
              </button>
            ))}
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between">
              <label
                htmlFor="inquiry-body"
                className="text-sm font-semibold text-navy-900"
              >
                問い合わせ本文
              </label>
              <button
                type="button"
                onClick={handleClear}
                className="text-sm text-blue-600 hover:underline"
              >
                クリア
              </button>
            </div>
            <textarea
              id="inquiry-body"
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              rows={5}
              className="mt-2 w-full rounded-lg border border-navy-200 p-3 text-sm text-navy-900 focus:border-blue-600 focus:outline-none"
            />
            <div className="mt-1 flex items-center justify-end text-xs">
              <span className={counterColor}>
                {trimmedLength} / {MAX_BODY_LENGTH}
              </span>
            </div>
          </div>

          <p className="mt-3 text-xs text-navy-500">
            ※
            入力内容の保存・送信は行いません。AIの判定に使うだけで、SlackやLINEにも投稿されません。
          </p>

          {error && (
            <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="mt-4 w-full rounded-lg bg-blue-600 py-3 text-base font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50 md:w-auto md:px-8"
          >
            {loading ? "AIが判定中…" : "AIで分類する"}
          </button>
        </div>
      </section>

      {/* 判定結果 */}
      <section
        ref={resultRef}
        className="scroll-mt-6 bg-navy-50 px-6 py-16"
        aria-live="polite"
      >
        <div className="mx-auto max-w-[720px]">
          <h2 className="text-xl font-bold md:text-2xl">判定結果</h2>

          {loading && (
            <div className="mt-6 animate-pulse space-y-3">
              <div className="h-8 w-40 rounded bg-navy-200" />
              <div className="h-16 rounded bg-navy-200" />
            </div>
          )}

          {!loading && result && (
            <div className="mt-6 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`rounded-full px-4 py-1.5 text-sm font-bold text-white ${
                    result.category === "クレーム"
                      ? "bg-[var(--color-alert)]"
                      : "bg-navy-700"
                  }`}
                >
                  {CATEGORY_EMOJI[result.category]} {result.category}
                </span>
                {result.isUrgent && (
                  <span className="rounded-full bg-[var(--color-alert-bg)] px-4 py-1.5 text-sm font-bold text-[var(--color-alert)]">
                    ⚡ 緊急
                  </span>
                )}
              </div>
              <div className="rounded-lg border border-navy-200 bg-white p-4">
                <p className="text-xs font-semibold text-navy-500">
                  AIの判定理由
                </p>
                <p className="mt-1 text-sm text-navy-900">{result.reason}</p>
              </div>
              {selectedSample?.revealText && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-navy-900">
                  {selectedSample.revealText}
                </div>
              )}
            </div>
          )}

          {!loading && !result && !error && (
            <p className="mt-6 text-sm text-navy-500">
              上の「AIで分類する」を押すと、ここに判定結果が表示されます。
            </p>
          )}
        </div>
      </section>

      {/* Slackカードプレビュー */}
      {result && (
        <section className="bg-white px-6 py-16">
          <div className="mx-auto max-w-[720px]">
            <h2 className="text-xl font-bold md:text-2xl">
              実際にSlackへ投稿されるカード
            </h2>
            <p className="mt-2 text-sm text-navy-500">
              ⓘ これは見た目の再現です（実際のSlackには投稿されません）
            </p>
            <div className="mt-4">
              <SlackCardPreview category={result.category} body={text.trim()} />
            </div>
          </div>
        </section>
      )}

      {/* LINE通知プレビュー */}
      {result && (
        <section className="bg-navy-50 px-6 py-16">
          <div className="mx-auto max-w-[720px]">
            <h2 className="text-xl font-bold md:text-2xl">
              営業部長のLINEへの通知
            </h2>
            <div className="mt-4">
              <LinePreview
                isUrgent={result.isUrgent}
                body={text.trim()}
                onTryComplaintSample={() => handleSampleClick(DEFAULT_SAMPLE)}
              />
            </div>
          </div>
        </section>
      )}

      {/* 精度検証（実測値） */}
      <section className="bg-white px-6 py-16">
        <div className="mx-auto max-w-[720px]">
          <h2 className="text-xl font-bold md:text-2xl">分類精度の検証</h2>
          <p className="mt-2 text-sm text-navy-700">
            実データ22件（data/case5-test-inquiries.csv）でテストしました。
          </p>
          <div className="mt-6 grid grid-cols-3 gap-4 text-center">
            <StatTile value="22 / 22" label="件 正解" />
            <StatTile value="0件" label="クレーム見逃し" />
            <StatTile value="0件" label="緊急の誤検知" />
          </div>
          <p className="mt-6 text-sm text-navy-700">
            内訳: 賃貸11 / 売買4 / 内見4 / クレーム2 / その他1。
            「緊急ではありません」を含む文を緊急と誤判定しないこと、
            無関係な雑談をクレーム扱いしないことを合格条件に含めています。
          </p>
        </div>
      </section>

      {/* フッター */}
      <footer className="bg-navy-900 px-6 py-16 text-navy-100">
        <div className="mx-auto max-w-[720px]">
          <h2 className="text-lg font-bold text-white">このデモについて</h2>
          <p className="mt-3 text-sm leading-relaxed">
            不動産会社向けの問い合わせ集約システムの模擬案件です。実際の運用では
            Gmail・LINE公式アカウントと連携し、Supabaseのキューを経由して処理します。
          </p>
          <p className="mt-3 text-sm">
            想定納期 5営業日 / 初期費用 14.8万円（税込）・月額 約1.5万円
          </p>
        </div>
      </footer>
    </main>
  );
}

function FlowBox({ label, highlight }: { label: string; highlight?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 text-center text-sm font-semibold ${
        highlight
          ? "border-blue-600 bg-blue-600 text-white"
          : "border-navy-200 bg-white text-navy-900"
      }`}
    >
      {label}
    </div>
  );
}

function Arrow() {
  return <span className="rotate-90 text-navy-400 md:rotate-0">→</span>;
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-navy-200 bg-navy-50 py-4">
      <p className="text-2xl font-bold text-navy-900">{value}</p>
      <p className="mt-1 text-xs text-navy-500">{label}</p>
    </div>
  );
}
