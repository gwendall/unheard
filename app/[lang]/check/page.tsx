import type { Metadata } from "next";
import { Check } from "@/components/Check";
import { alternates, LANGUAGES, messages, pathFor, type Locale } from "@/lib/i18n";

// Does a video give away where it was made? The faint tone of a propeller plane in its sound,
// matched to flight data, can place it. This page finds those tones in a file and takes them out,
// all in the browser (components/Check.tsx, lib/core/leak.ts).

export async function generateMetadata({ params }: PageProps<"/[lang]/check">): Promise<Metadata> {
  const lang = (await params).lang as Locale;
  const { meta } = await messages(lang);
  return {
    title: meta.checkTitle,
    description: meta.checkDescription,
    alternates: alternates(lang, "/check"),
    // The layout's image (app/[lang]/opengraph-image.tsx) stays; the rest of these objects is replaced, not merged.
    openGraph: { type: "website", siteName: "Unheard", locale: LANGUAGES[lang].og, title: meta.checkTitle, description: meta.checkDescription },
    twitter: { card: "summary_large_image", title: meta.checkTitle, description: meta.checkDescription },
  };
}

export default async function CheckPage({ params }: PageProps<"/[lang]/check">) {
  const lang = (await params).lang as Locale;
  const t = (await messages(lang)).check;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-8 px-5 pt-12 pb-16 sm:px-8 sm:pt-16">
      <header className="flex flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{t.title}</h1>
        <p className="max-w-prose text-lg text-pretty text-mute">{t.lead}</p>
        <p className="flex max-w-prose items-baseline gap-3 text-pretty text-ink" data-testid="check-private">
          <span aria-hidden className="size-1.5 shrink-0 translate-y-[-0.15em] rounded-full bg-amber/70" />
          {t.private}
        </p>
      </header>
      <Check elsewhere={pathFor(lang, "/somewhere-else")} />
      <section className="flex flex-col gap-3" aria-labelledby="scope">
        <h2 id="scope" className="text-sm font-medium tracking-wide text-mute uppercase">
          {t.scope.title}
        </h2>
        <p className="max-w-prose text-pretty text-mute">{t.scope.yes}</p>
        <p className="max-w-prose text-pretty text-mute">{t.scope.no}</p>
      </section>
    </main>
  );
}
