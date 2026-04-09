import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bike Radar — Find Your Stolen Bike",
  description:
    "Search Marktplaats for your stolen bicycle using AI-powered matching",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl">
      <body className="antialiased">{children}</body>
    </html>
  );
}
