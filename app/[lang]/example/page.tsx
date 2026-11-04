import type { Metadata } from "next";
import { WhereMain } from "@/components/WhereMain";
import { alternates, LANGUAGES, messages, type Locale } from "@/lib/i18n";

// The page of /where with a simulated file already in it (lib/client/where-example.ts): the whole
// answer for whoever has no file to hand, reached by the same search and the same rule.

export async function generateMetadata({ params }: PageProps<"/[lang]/example">): Promise<Metadata> {
  const lang = (await params).lang as Locale;
  const { meta } = await messages(lang);
  return {
    title: meta.exampleTitle,
    description: meta.exampleDescription,
    alternates: alternates(lang, "/example"),
    // The layout's image (app/[lang]/opengraph-image.tsx) stays; the rest of these objects is replaced, not merged.
    openGraph: { type: "website", siteName: "Unheard", locale: LANGUAGES[lang].og, title: meta.exampleTitle, description: meta.exampleDescription },
    twitter: { card: "summary_large_image", title: meta.exampleTitle, description: meta.exampleDescription },
  };
}

export default async function ExamplePage({ params }: PageProps<"/[lang]/example">) {
  return <WhereMain lang={(await params).lang as Locale} example />;
}
