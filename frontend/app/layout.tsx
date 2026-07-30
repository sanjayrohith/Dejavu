import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Film from "@/components/Film";
import "./globals.css";

/* Sans for narrative copy, mono for anything that is literally data —
   the split mirrors a real distinction in the product (DESIGN.md §4). */
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Dejavu — memory that lets coding agents continue instead of start over",
  description:
    "Repository-scoped memory and handoffs for coding agents. Local, bounded, cited recall from one inspectable SQLite file. No account, no daemon, no embeddings required.",
  openGraph: {
    title: "Dejavu — memory for coding agents",
    description:
      "Repository-scoped memory and handoffs for coding agents. Local, bounded, cited.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <head>
        {/* the opening frame is the hero's background — fetch it with the
            document, not after the client bundle has booted */}
        <link
          rel="preload"
          as="image"
          href="/frames/hd/001.webp"
          media="(min-width: 901px)"
        />
        <link
          rel="preload"
          as="image"
          href="/frames/sm/001.webp"
          media="(max-width: 900px)"
        />
      </head>
      <body>
        <Film />
        {children}
      </body>
    </html>
  );
}
