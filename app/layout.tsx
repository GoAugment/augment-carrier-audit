import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Carrier Safety Audit — Augment",
  description:
    "Free pre-tender carrier safety audit for freight brokers. Built for the post-Montgomery era. Paste DOT numbers, get a defensible risk report in seconds.",
  openGraph: {
    title: "Carrier Safety Audit — Augment",
    description:
      "Free pre-tender carrier safety audit for freight brokers. Paste DOT numbers, get a defensible risk report.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
