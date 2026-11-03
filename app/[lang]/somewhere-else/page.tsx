import type { Metadata } from "next";
import { Elsewhere } from "@/components/Elsewhere";
import { alternates, LANGUAGES, messages, type Locale } from "@/lib/i18n";

export async function generateMetadata({ params }: PageProps<"/[lang]/somewhere-else">): Promise<Metadata> {
  const lang = (await params).lang as Locale;
  const { meta } = await messages(lang);
  return {
    title: meta.elsewhereTitle,
    description: meta.elsewhereDescription,
    alternates: alternates(lang, "/somewhere-else"),
    // The layout's image (app/[lang]/opengraph-image.tsx) stays; the rest of these objects is replaced, not merged.
    openGraph: { type: "website", siteName: "Unheard", locale: LANGUAGES[lang].og, title: meta.elsewhereTitle, description: meta.elsewhereDescription },
    twitter: { card: "summary_large_image", title: meta.elsewhereTitle, description: meta.elsewhereDescription },
  };
}

export default function SomewhereElse() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-5 pt-10 pb-16 sm:px-8 sm:pt-16">
      <Elsewhere />
    </main>
  );
}
