import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { notFound } from "next/navigation";
import { dict, isLang, LANGS } from "@/lib/i18n";
import { LangProvider } from "@/lib/i18n/client";
import "../globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

// Both languages are built ahead; any other first segment is a 404.
export const dynamicParams = false;
export const generateStaticParams = () => LANGS.map((lang) => ({ lang }));

// The image comes from opengraph-image.tsx and twitter-image.tsx next to this file.
export async function generateMetadata({ params }: LayoutProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  const { meta } = dict(lang);
  return {
    metadataBase: new URL("https://unheard.gwendall.com"),
    title: meta.title,
    description: meta.description,
    alternates: { canonical: `/${lang}`, languages: { en: "/en", fr: "/fr", "x-default": "/" } },
    openGraph: { type: "website", siteName: "Unheard", locale: meta.ogLocale, title: meta.shareTitle, description: meta.description },
    twitter: { card: "summary_large_image", title: meta.shareTitle, description: meta.description },
  };
}

export const viewport: Viewport = {
  themeColor: "#05070d",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return (
    <html lang={lang} className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">
        <div aria-hidden className="stars pointer-events-none fixed inset-0" />
        <LangProvider lang={lang}>
          <div className="relative">{children}</div>
        </LangProvider>
      </body>
    </html>
  );
}
