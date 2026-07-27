import type { Metadata } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono, Kanit, Sarabun } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-body",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const kanit = Kanit({
  variable: "--font-game",
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
});

const sarabun = Sarabun({
  variable: "--font-game-body",
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "RxSmart — กายภาพบำบัด",
  description: "ดูท่าทางกายภาพบำบัดแบบเรียลไทม์จาก sensor 8 จุด",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="th"
      className={`${inter.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} ${kanit.variable} ${sarabun.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
