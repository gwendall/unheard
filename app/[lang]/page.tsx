import Link from "next/link";
import { renderSVG } from "uqr";
import { Listener } from "@/components/Listener";
import results from "@/evals/results.json";
import { dict, locale, type Lang } from "@/lib/i18n";

// The way from a computer to a phone: a QR code of the site, drawn once on the server. The bare
// address, so the phone opens it in its own language.
const QR = renderSVG("https://unheard.gwendall.com", { border: 0, whiteColor: "#e8ecf4", blackColor: "#05070d" });

const REPO = "https://github.com/gwendall/unheard";

// The scoreboard, read when the page is built: the same numbers as the README, from the same file.
const evals = Object.values(results);
const sum = (f: (e: (typeof evals)[number]) => number) => evals.reduce((n, e) => n + f(e), 0);
const sureWrong = sum((e) => e.heard.wrongStrong + e.empty.falseStrong);
const nothing = sum((e) => e.empty.n);
const tested = sum((e) => e.heard.n) + nothing;
const real = results["real-audio"].heard;
const lastRun = new Date(evals.map((e) => e.date).sort().at(-1)!);

export default async function Home({ params }: PageProps<"/[lang]">) {
  const lang = (await params).lang as Lang;
  const t = dict(lang);
  const measured = lastRun.toLocaleDateString(locale(lang), { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const proof = [
    { value: String(sureWrong), label: t.proof.wrong(sureWrong, tested, nothing) },
    { value: t.proof.realValue(real.anyHit, real.n), label: t.proof.real(real.strongHit) },
    { value: t.proof.yoursValue, label: t.proof.yours },
  ];
  return (
    <main className="flex min-h-dvh flex-col">
      <Listener qr={QR} />
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8" aria-labelledby="how">
        <h2 id="how" className="mb-6 text-sm font-medium tracking-wide text-mute uppercase">
          {t.how.title}
        </h2>
        <ol className="grid gap-6 sm:grid-cols-3">
          {t.how.steps.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-2 rounded-2xl border border-line bg-deep/70 p-5">
              <span className="font-mono text-xs text-amber">0{i + 1}</span>
              <h3 className="text-lg font-semibold text-balance">{s.title}</h3>
              <p className="text-pretty text-mute">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8" aria-labelledby="proof">
        <h2 id="proof" className="mb-2 text-sm font-medium tracking-wide text-mute uppercase">
          {t.proof.title}
        </h2>
        <p className="mb-6 max-w-prose text-pretty text-mute">{t.proof.lead}</p>
        <dl className="grid gap-6 sm:grid-cols-3" data-testid="proof">
          {proof.map((p) => (
            <div key={p.value} className="flex flex-col gap-2 rounded-2xl border border-line bg-deep/70 p-5">
              <dt className="order-2 text-pretty text-mute">{p.label}</dt>
              <dd className="order-1 font-mono text-3xl font-semibold text-ink tabular-nums">{p.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-sm text-faint">
          {t.proof.measured(measured)}{" "}
          <a href={`${REPO}#scoreboard`} className="text-mute underline-offset-4 transition hover:text-ink hover:underline">
            {t.proof.scoreboard} <span aria-hidden>→</span>
          </a>
        </p>
      </section>
      <footer className="mx-auto mt-auto flex w-full max-w-6xl flex-wrap gap-x-6 gap-y-2 px-5 pb-10 text-sm text-faint sm:px-8">
        <a href={REPO} className="transition hover:text-ink">
          {t.footer.github}
        </a>
        <Link href={`/${lang}/privacy`} className="transition hover:text-ink">
          {t.footer.privacy}
        </Link>
        <a href="mailto:unheard@gwendall.com" className="transition hover:text-ink">
          unheard@gwendall.com
        </a>
        <Link href={`/${t.footer.other.lang}`} hrefLang={t.footer.other.lang} lang={t.footer.other.lang} className="transition hover:text-ink">
          {t.footer.other.label}
        </Link>
        <a href="https://gwendall.com" className="transition hover:text-ink sm:ml-auto">
          {t.footer.madeBy}
        </a>
      </footer>
    </main>
  );
}
