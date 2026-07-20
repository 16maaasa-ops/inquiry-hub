import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "問い合わせ集約 + AI分類システム",
  description:
    "Gmail・LINEの問い合わせをSlackに自動集約し、AIが4分類+その他に振り分け。クレームは5分以内に営業部長のLINEへ通知します。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
