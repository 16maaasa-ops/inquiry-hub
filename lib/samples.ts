// デモ画面の「試してみる」用サンプル。
// data/case5-test-inquiries.csv の実データから6件を抜粋している（すべて実測で正解済み）。
//
// 選定意図:
//   - 賃貸/売買/内見/クレームの通常4分類を1件ずつ
//   - 「今日の天気」（無関係な雑談）でノイズ耐性を見せる
//   - 「緊急ではありません」を含む文で、キーワード一致ではなく文脈判断であることを見せる
// 最後の2件は revealText を用意し、結果表示後に「なぜこれが見せ場なのか」を種明かしする。

export interface Sample {
  id: string;
  label: string;
  body: string;
  revealText?: string;
}

export const SAMPLES: Sample[] = [
  {
    id: "complaint",
    label: "エアコンが効かない 🔥",
    body: "先月入居した部屋のエアコンが効きません。至急対応してください。苦情です。",
  },
  {
    id: "rental",
    label: "駅近1LDKを探したい",
    body: "駅近の1LDKを探しています。家賃8万円くらいで空いている物件はありますか？",
  },
  {
    id: "sale",
    label: "中古マンションを買いたい",
    body: "中古マンションの購入を検討しています。予算3000万円台で良い物件はありますか？",
  },
  {
    id: "viewing",
    label: "週末に内見したい",
    body: "先日問い合わせた港区の物件、週末に内見をお願いできますか？",
  },
  {
    id: "noise",
    label: "今日の天気は？ 🤔",
    body: "今日の天気はどうですか？",
    revealText:
      "🤔 この文には「至急」も「困って」も無いのに、AIが問い合わせですらないと見抜いています。",
  },
  {
    id: "false-urgent",
    label: "「緊急ではありません」を含む文 ⚠️",
    body: "退去時の敷金精算について教えてください。これは緊急ではありません。",
    revealText:
      "⚠️ 「緊急」という語が入っていますが、AIは「緊急ではありません」という文脈を読んで緊急にしていません。キーワード一致では、ここで誤検知が起きます。",
  },
];

// 初期表示に使う既定サンプル（要件：空だと離脱するため、クレーム例を入れておく）
export const DEFAULT_SAMPLE = SAMPLES[0];

export const MAX_BODY_LENGTH = 1000;
