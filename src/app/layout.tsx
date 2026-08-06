import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CuxmTier — Smarter SportyBet Slips",
  description: "Analyze your SportyBet booking codes, remove risky picks, and get a leaner slip. Powered by data.",
  openGraph: {
    title: "CuxmTier — Smarter SportyBet Slips",
    description: "Analyze your SportyBet booking codes, remove risky picks, and get a leaner slip.",
    siteName: "CuxmTier",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-[#0a0a0a] text-white">{children}</body>
    </html>
  );
}
