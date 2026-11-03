import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { notFound } from "next/navigation";
import { I18nProvider } from "@/components/I18n";
import { LanguageMenu } from "@/components/LanguageMenu";
import { alternates, isLocale, LANGUAGES, LOCALES, messages, pathFor } from "@/lib/i18n";
import "../globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

// Every language is built ahead; any other first segment is a 404. English is served at / (see
// next.config.ts), the others under their code.
export const dynamicParams = false;
export const generateStaticParams = () => LOCALES.map((lang) => ({ lang }));

// The image comes from opengraph-image.tsx and twitter-image.tsx next to this file.
export async function generateMetadata({ params }: LayoutProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const { meta } = await messages(lang);
  return {
    metadataBase: new URL("https://unheard.gwendall.com"),
    title: meta.title,
    description: meta.description,
    alternates: alternates(lang),
    openGraph: { type: "website", siteName: "Unheard", locale: LANGUAGES[lang].og, title: meta.shareTitle, description: meta.description },
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
  if (!isLocale(lang)) notFound();
  const m = await messages(lang);
  return (
    <html lang={LANGUAGES[lang].tag} className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">
        <div aria-hidden className="stars pointer-events-none fixed inset-0" />
        <I18nProvider locale={lang} messages={m}>
          <div className="relative">
            {/* The same header on every screen: the name, home, and the language. */}
            <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 pt-5 sm:px-8 sm:pt-8">
              <Link href={pathFor(lang)} aria-label={m.nav.home} className="font-mono text-sm tracking-[0.2em] text-amber uppercase">
                Unheard
              </Link>
              <LanguageMenu current={lang} label={m.nav.language} />
            </header>
            {children}
          </div>
        </I18nProvider>
      </body>
    </html>
  );
}
