import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
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
  metadataBase: new URL('https://www.tennisdeepstats.com'),
  title: {
    default: "Tennis Deep Stats",
    template: "%s | Tennis Deep Stats",
  },
  description: "Free ATP tennis stats tool. Compare players head-to-head on clay, hard, and grass. Surface win rates, serve & return stats for every ATP match.",
  keywords: ["tennis stats", "ATP stats", "tennis head to head", "clay court stats", "tennis surface stats", "French Open stats", "tennis analytics"],
  openGraph: {
    title: "Tennis Deep Stats",
    description: "Compare ATP players head-to-head on any surface. Free tennis analytics tool.",
    type: "website",
    url: "https://www.tennisdeepstats.com",
    siteName: "Tennis Deep Stats",
  },
  twitter: {
    card: "summary",
    title: "Tennis Deep Stats",
    description: "Compare ATP players head-to-head on any surface. Free tennis analytics tool.",
  },
  robots: {
    index: true,
    follow: true,
  },
  verification: {
    google: 'U1ppqwDvWmg4oNuMWtGR_VEGfbThUo9-di0r2Ga-SBA',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}
