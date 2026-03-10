// Root layout for Voice CC landing page.
// - Loads IBM Plex Serif font via next/font/google
// - Applies global styles

import type { Metadata } from "next";
import { IBM_Plex_Serif } from "next/font/google";
import "./globals.css";

const ibmPlexSerif = IBM_Plex_Serif({
  variable: "--font-ibm-plex-serif",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Voice CC",
  description:
    "A Claude Code plugin that adds a /voice command for hands-free voice interaction.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={ibmPlexSerif.variable}>{children}</body>
    </html>
  );
}
