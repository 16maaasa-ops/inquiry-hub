// data/case5-test-inquiries.csv を使った分類精度テスト。
// 実行方法: npx tsx scripts/test-classification.ts
//
// 必須合格条件（要件定義書より）:
//   - クレーム2件（No.19, 20）を見逃さないこと
//   - No.21（無関係な雑談）を「その他」に分類し、クレーム誤判定しないこと
//   - No.22（「緊急ではありません」を含む賃貸の質問）を緊急扱いしないこと

import { readFileSync } from "fs";
import { join } from "path";
import { classifyInquiry } from "../lib/claude";
import type { Category } from "../lib/types";

interface TestRow {
  no: string;
  channel: string;
  body: string;
  expectedCategory: Category;
  expectedUrgent: boolean;
  feature: string;
}

function parseCsv(content: string): TestRow[] {
  const lines = content.trim().split("\n");
  const rows = lines.slice(1); // ヘッダー行を除く
  return rows.map((line) => {
    const [no, channel, body, expectedCategory, expectedUrgent, feature] =
      line.split(",");
    return {
      no,
      channel,
      body,
      expectedCategory: expectedCategory as Category,
      expectedUrgent: expectedUrgent.trim().toUpperCase() === "TRUE",
      feature,
    };
  });
}

async function main() {
  const csvPath = join(__dirname, "..", "data", "case5-test-inquiries.csv");
  const rows = parseCsv(readFileSync(csvPath, "utf-8"));

  let correctCategory = 0;
  let correctUrgent = 0;
  const failures: string[] = [];

  for (const row of rows) {
    // CSVの「その他/分類対象外」は分類スキーマ上の「その他」に正規化する
    const expectedCategory = row.expectedCategory.startsWith("その他")
      ? "その他"
      : row.expectedCategory;

    const result = await classifyInquiry(row.body);

    const categoryOk = result.category === expectedCategory;
    const urgentOk = result.isUrgent === row.expectedUrgent;

    if (categoryOk) correctCategory += 1;
    if (urgentOk) correctUrgent += 1;

    const mark = categoryOk && urgentOk ? "OK" : "NG";
    console.log(
      `[${mark}] No.${row.no} 期待:${expectedCategory}/緊急${row.expectedUrgent} → 実際:${result.category}/緊急${result.isUrgent} (${row.feature})`,
    );

    if (!categoryOk || !urgentOk) {
      failures.push(
        `No.${row.no}: ${row.body}\n    → AIの理由: ${result.reason}`,
      );
    }
  }

  console.log("\n===== 結果 =====");
  console.log(`カテゴリ正答率: ${correctCategory}/${rows.length}`);
  console.log(`緊急判定正答率: ${correctUrgent}/${rows.length}`);
  if (failures.length > 0) {
    console.log("\n不一致だったケース:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  } else {
    console.log("\n全件一致しました。");
  }
}

main().catch((error) => {
  console.error("テスト実行中にエラーが発生しました:", error);
  process.exitCode = 1;
});
