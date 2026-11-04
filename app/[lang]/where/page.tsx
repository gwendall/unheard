import type { Metadata } from "next";
import { DoorHeader } from "@/components/DoorHeader";
import { Where } from "@/components/Where";
import { ARCHIVE_URL } from "@/lib/archive";
import { alternates, LANGUAGES, messages, pathFor, type Locale } from "@/lib/i18n";

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
  const lang = (await params).lang as Locale;
  const all = await messages(lang);
  const t = all.where;
  const scope = all.check.scope;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-8 px-5 pt-10 pb-16 sm:px-8 sm:pt-16">
      <DoorHeader title={t.title} lead={t.lead} note={t.private} />
      <Where
        archive={ARCHIVE_URL || null}
        elsewhere={pathFor(lang, "/somewhere-else")}
        scope={
          <section className="flex flex-col gap-3" aria-labelledby="scope" data-testid="where-scope">
            <h2 id="scope" className="text-sm font-medium tracking-wide text-mute uppercase">
              {scope.title}
            </h2>
            <p className="max-w-prose text-pretty text-mute">{scope.yes}</p>
            <p className="max-w-prose text-pretty text-mute">{scope.no}</p>
          </section>
        }
      />
    </main>
  );
}
