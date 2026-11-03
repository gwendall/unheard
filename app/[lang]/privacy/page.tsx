import type { Metadata } from "next";
import { alternates, messages, type Locale } from "@/lib/i18n";

export async function generateMetadata({ params }: PageProps<"/[lang]/privacy">): Promise<Metadata> {
  const lang = (await params).lang as Locale;
  return { title: (await messages(lang)).meta.privacyTitle, alternates: alternates(lang, "/privacy") };
}

export default async function Privacy({ params }: PageProps<"/[lang]/privacy">) {
  const lang = (await params).lang as Locale;
  const t = (await messages(lang)).privacy;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-10 px-5 pt-12 pb-16 sm:px-8 sm:pt-16">
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{t.title}</h1>
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
