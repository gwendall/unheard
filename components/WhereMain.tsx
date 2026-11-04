import { Where } from "@/components/Where";
import { ARCHIVE_URL } from "@/lib/archive";
import { messages, pathFor, type Locale } from "@/lib/i18n";

/** The page of /where and of /example, which only comes with its file. */
export async function WhereMain({ lang, example }: { lang: Locale; example?: boolean }) {
  const { scope } = (await messages(lang)).check;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-8 px-5 pt-10 pb-16 sm:px-8 sm:pt-16">
      <Where
        archive={ARCHIVE_URL || null}
        elsewhere={pathFor(lang, "/somewhere-else")}
        example={example}
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
