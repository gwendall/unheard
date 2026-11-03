import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const SHARE_TITLE = "Unheard: your phone names the plane flying over you";
const DESCRIPTION =
  "Hold your phone up to the sky for a couple of minutes. Unheard picks out the faint drone of a plane in the noise and tells you which plane it was, from live flight data.";

// The image comes from app/opengraph-image.tsx and app/twitter-image.tsx.
export const metadata: Metadata = {
  metadataBase: new URL("https://unheard.gwendall.com"),
  title: "Unheard: the plane you can't hear",
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Unheard", locale: "en_US", title: SHARE_TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: SHARE_TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: "#05070d",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">
        <div aria-hidden className="stars pointer-events-none fixed inset-0" />
        <div className="relative">{children}</div>
      </body>
    </html>
  );
}
