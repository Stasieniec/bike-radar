import type { Metadata } from "next";
import "./globals.css";

const DOMAIN = "https://bikeradar.swasilewski.com";

export const metadata: Metadata = {
  title: "Bike Radar — Find Your Stolen Bike on Marktplaats",
  description:
    "AI-powered tool that scans Marktplaats listings to help you recover your stolen bicycle. Describe your bike, and we'll search hundreds of listings using Gemini vision AI.",
  metadataBase: new URL(DOMAIN),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Bike Radar — Find Your Stolen Bike on Marktplaats",
    description:
      "AI-powered tool that scans Marktplaats listings to help you recover your stolen bicycle.",
    url: DOMAIN,
    siteName: "Bike Radar",
    locale: "nl_NL",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Bike Radar — Find Your Stolen Bike",
    description:
      "AI-powered Marktplaats scanner to help recover stolen bicycles in the Netherlands.",
  },
  robots: {
    index: true,
    follow: true,
  },
  keywords: [
    "stolen bike",
    "fiets gestolen",
    "Marktplaats",
    "bike finder",
    "Netherlands",
    "fiets zoeken",
    "gestolen fiets terugvinden",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebApplication",
              name: "Bike Radar",
              url: DOMAIN,
              description:
                "AI-powered tool that scans Marktplaats listings to help recover stolen bicycles in the Netherlands.",
              applicationCategory: "UtilityApplication",
              operatingSystem: "Any",
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "EUR",
              },
              inLanguage: ["nl", "en"],
            }),
          }}
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
