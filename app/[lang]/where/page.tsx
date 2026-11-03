import type { Metadata } from "next";
import { Where } from "@/components/Where";
import { ARCHIVE_SET, ARCHIVE_URL } from "@/lib/archive";
import { alternates, LANGUAGES, messages, pathFor, type Locale } from "@/lib/i18n";

// Where and when was a file recorded? The planes in its sound, matched to a flight archive, in the
// browser (components/Where.tsx, lib/core/wherewhen.ts). The archive's address is one setting
// (lib/archive.ts); without it the page says so and offers no search.

export async function generateMetadata({ params }: PageProps<"/[lang]/where">): Promise<Metadata> {
  const lang = (await params).lang as Locale;
  const { meta } = await messages(lang);
  return {
    title: meta.whereTitle,
    description: meta.whereDescription,
    alternates: alternates(lang, "/where"),
    // Linked from nowhere and kept out of the search engines until the archive is set.
    robots: ARCHIVE_SET ? undefined : { index: false },
    // The layout's image (app/[lang]/opengraph-image.tsx) stays; the rest of these objects is replaced, not merged.
    openGraph: { type: "website", siteName: "Unheard", locale: LANGUAGES[lang].og, title: meta.whereTitle, description: meta.whereDescription },
    twitter: { card: "summary_large_image", title: meta.whereTitle, description: meta.whereDescription },
  };
}

export default async function WherePage({ params }: PageProps<"/[lang]/where">) {
  const lang = (await params).lang as Locale;
  const t = (await messages(lang)).where;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-8 px-5 pt-12 pb-16 sm:px-8 sm:pt-16">
      <header className="flex flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{t.title}</h1>
        <p className="max-w-prose text-lg text-pretty text-mute">{t.lead}</p>
        <p className="flex items-baseline gap-3 text-pretty text-ink" data-testid="where-private">
          <span aria-hidden className="size-1.5 shrink-0 translate-y-[-0.15em] rounded-full bg-amber/70" />
          {t.private}
        </p>
      </header>
      <Where archive={ARCHIVE_URL || null} check={pathFor(lang, "/check")} />
    </main>
  );
}
