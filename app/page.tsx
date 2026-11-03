import Link from "next/link";
import { renderSVG } from "uqr";
import { Listener } from "@/components/Listener";
import results from "@/evals/results.json";

// The way from a computer to a phone: a QR code of the site, drawn once on the server.
const QR = renderSVG("https://unheard.gwendall.com", { border: 0, whiteColor: "#e8ecf4", blackColor: "#05070d" });

const REPO = "https://github.com/gwendall/unheard";

const STEPS = [
  {
    title: "Wait for a plane",
    body: "The page shows the aircraft around you from live flight data: which one will pass closest, and when. Propeller planes and helicopters hum the steadiest, so they are the easiest to find.",
  },
  {
    title: "Hold your phone up",
    body: "Start when it says so and point your phone at the sky. It records for a minute or two and stops by itself once the plane has gone.",
  },
  {
    title: "Get its name",
    body: "Its hum is a little higher while it comes, a little lower once it leaves: the Doppler effect. Your phone works out the curve each plane should have left where you stand, finds the one in your recording, and names the plane.",
  },
];

// The scoreboard, read when the page is built: the same numbers as the README, from the same file.
const evals = Object.values(results);
const sum = (f: (e: (typeof evals)[number]) => number) => evals.reduce((n, e) => n + f(e), 0);
const sureWrong = sum((e) => e.heard.wrongStrong + e.empty.falseStrong);
const nothing = sum((e) => e.empty.n);
const tested = sum((e) => e.heard.n) + nothing;
const real = results["real-audio"].heard;
const measured = new Date(evals.map((e) => e.date).sort().at(-1)!).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const PROOF = [
  {
    value: String(sureWrong),
    label: (
      <>
        wrong {sureWrong === 1 ? "name" : "names"} when it says &ldquo;It was&rdquo;, over {tested} test recordings, {nothing} of them with no plane to find. When the trace is faint it says &ldquo;probably&rdquo;.
      </>
    ),
  },
  {
    value: `${real.anyHit} of ${real.n}`,
    label: (
      <>
        real recorded flybys, near Adelaide, named right: {real.strongHit} for sure, the others as &ldquo;probably&rdquo;.
      </>
    ),
  },
  {
    value: "Yours",
    label: <>Phone recordings are the next test. After a match you can give yours, with no place or time attached.</>,
  },
];

export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col">
      <Listener qr={QR} />
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8" aria-labelledby="how">
        <h2 id="how" className="mb-6 text-sm font-medium tracking-wide text-mute uppercase">
          How it works
        </h2>
        <ol className="grid gap-6 sm:grid-cols-3">
          {STEPS.map((s, i) => (
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
          Does it work?
        </h2>
        <p className="mb-6 max-w-prose text-pretty text-mute">Every change is tested on recorded flybys before it ships. One rule never bends: when Unheard says &ldquo;It was&rdquo;, it must be right.</p>
        <dl className="grid gap-6 sm:grid-cols-3" data-testid="proof">
          {PROOF.map((p) => (
            <div key={p.value} className="flex flex-col gap-2 rounded-2xl border border-line bg-deep/70 p-5">
              <dt className="order-2 text-pretty text-mute">{p.label}</dt>
              <dd className="order-1 font-mono text-3xl font-semibold text-ink tabular-nums">{p.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-sm text-faint">
          Last measured on {measured}.{" "}
          <a href={`${REPO}#scoreboard`} className="text-mute underline-offset-4 transition hover:text-ink hover:underline">
            Every number and how it is measured <span aria-hidden>→</span>
          </a>
        </p>
      </section>
      <footer className="mx-auto mt-auto flex w-full max-w-6xl flex-wrap gap-x-6 gap-y-2 px-5 pb-10 text-sm text-faint sm:px-8">
        <a href={REPO} className="transition hover:text-ink">
          Open source on GitHub
        </a>
        <Link href="/privacy" className="transition hover:text-ink">
          Privacy
        </Link>
        <a href="mailto:unheard@gwendall.com" className="transition hover:text-ink">
          unheard@gwendall.com
        </a>
        <a href="https://gwendall.com" className="transition hover:text-ink sm:ml-auto">
          Made by Gwendall
        </a>
      </footer>
    </main>
  );
}
