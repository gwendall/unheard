import type { Metadata } from "next";
import { WhereMain } from "@/components/WhereMain";
import { alternates, LANGUAGES, messages, type Locale } from "@/lib/i18n";

// One door for a file: what it says about itself, its aircraft tones, then where and when it was
// recorded (the planes in its sound, matched to a flight archive) and taking the tones out, all in
// the browser (components/Where.tsx). The archive's address is one setting (lib/archive.ts);
// without it the page says so and offers no search.

export async function generateMetadata({ params }: PageProps<"/[lang]/where">): Promise<Metadata> {
  const lang = (await params).lang as Locale;
  const { meta } = await messages(lang);
  return {
    title: meta.whereTitle,
    description: meta.whereDescription,
    alternates: alternates(lang, "/where"),
    // The layout's image (app/[lang]/opengraph-image.tsx) stays; the rest of these objects is replaced, not merged.
    openGraph: { type: "website", siteName: "Unheard", locale: LANGUAGES[lang].og, title: meta.whereTitle, description: meta.whereDescription },
    twitter: { card: "summary_large_image", title: meta.whereTitle, description: meta.whereDescription },
  };
}

export default async function WherePage({ params }: PageProps<"/[lang]/where">) {
  return <WhereMain lang={(await params).lang as Locale} />;
}
