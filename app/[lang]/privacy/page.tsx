import type { Metadata } from "next";
import Link from "next/link";
import { dict, type Lang } from "@/lib/i18n";

export async function generateMetadata({ params }: PageProps<"/[lang]/privacy">): Promise<Metadata> {
  const lang = (await params).lang as Lang;
  return { title: dict(lang).meta.privacyTitle, alternates: { canonical: `/${lang}/privacy`, languages: { en: "/en/privacy", fr: "/fr/privacy" } } };
}

export default async function Privacy({ params }: PageProps<"/[lang]/privacy">) {
  const lang = (await params).lang as Lang;
  const t = dict(lang).privacy;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-10 px-5 py-16 sm:px-8">
      <header className="flex flex-col gap-3">
        <Link href={`/${lang}`} className="text-xs font-medium tracking-[0.3em] text-amber uppercase">
          Unheard
        </Link>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{t.title}</h1>
      </header>
      {t.sections.map((s) => (
        <section key={s.title} className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-balance">{s.title}</h2>
          {s.body.map((p) => (
            <p key={p.slice(0, 24)} className="max-w-prose text-pretty text-mute">
              {p}
            </p>
          ))}
        </section>
      ))}
    </main>
  );
}
