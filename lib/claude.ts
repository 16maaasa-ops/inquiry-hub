// Claude API による問い合わせ分類（不動産会社向け）

import Anthropic from "@anthropic-ai/sdk";
import { CATEGORIES, type Category } from "./types";

// クライアント生成は実際に使われるタイミングまで遅延させている。
// lib/supabase.ts と同じ理由: モジュール読み込み時に new Anthropic() すると
// APIキー未設定でビルド時のページデータ収集がエラーになるため。
let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

const SYSTEM_PROMPT = `あなたは不動産会社の問い合わせ分類アシスタントです。
届いた問い合わせ本文を読み、以下の5カテゴリのいずれか1つに分類してください。

- 賃貸: 賃貸物件の検索・条件相談・更新など
- 売買: 物件の購入・売却の相談
- 内見: 内見の予約・日程調整
- クレーム: 苦情、契約や物件への不満、至急対応を求める問題
- その他: 上記のいずれにも当てはまらない内容（雑談、スパム、無関係な質問など）

判断基準:
- クレームかどうか迷う場合は、必ず「クレーム」に分類してください（見逃しの方が空振りより悪い）。
- ただし「緊急ではありません」「急ぎではない」のように本人が明示的に緊急性を否定している場合は、
  文中に「至急」「困っています」等の語があっても is_urgent は false にしてください。
  文脈全体で判断し、単純なキーワード一致で判定しないこと。
- is_urgent は category が「クレーム」の場合のみ true にしてください。それ以外は必ず false です。
- reason には、なぜそのカテゴリ・緊急度と判断したかを1〜2文・80字以内の日本語で書いてください。
  判定より先に理由を考えることで、判定の精度が上がります。`;

export interface ClassificationResult {
  category: Category;
  isUrgent: boolean;
  reason: string;
}

export async function classifyInquiry(
  body: string,
): Promise<ClassificationResult> {
  const response = await getClient().messages.create({
    model: "claude-opus-4-8",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: body }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            // reason を先頭に置く: structured outputs はプロパティの順番どおりに
            // 生成するため、理由を先に考えさせてから結論（category/is_urgent）を
            // 出させることで判定精度が上がる。
            reason: { type: "string" },
            category: { type: "string", enum: CATEGORIES },
            is_urgent: { type: "boolean" },
          },
          required: ["reason", "category", "is_urgent"],
          additionalProperties: false,
        },
      },
    },
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude からのテキスト応答が取得できませんでした");
  }

  const parsed = JSON.parse(textBlock.text) as {
    category: Category;
    is_urgent: boolean;
    reason: string;
  };
  return {
    category: parsed.category,
    isUrgent: parsed.is_urgent,
    reason: parsed.reason,
  };
}
