import { renderSVG } from "uqr";
import { Listener } from "@/components/Listener";

// The way from a computer to a phone: a QR code of the site, drawn once on the server.
const QR = renderSVG("https://unheard.gwendall.com", { border: 0, whiteColor: "#e8ecf4", blackColor: "#05070d" });

const STEPS = [
  {
    title: "The Doppler curve",
    body: "A propeller hums at a steady pitch. While the plane comes toward you the pitch is a little higher, once it leaves a little lower. That bend is usually too faint to hear, but it is there in the sound, and a spectrum shows it.",
  },
  {
    title: "The flight data",
    body: "Most aircraft broadcast their position, speed and altitude every second. While you listen, the page follows every one of them within 30 km, using only your rough area.",
  },
  {
    title: "The match",
    body: "For each aircraft, your phone works out the exact curve you should have heard where you stand, including the seconds the sound took to reach you, and looks for it in your recording. The one that fits is the plane you heard.",
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
      <footer className="mx-auto mt-auto w-full max-w-6xl px-5 pb-10 text-sm text-faint sm:px-8">
        <a href="https://gwendall.com" className="transition hover:text-ink">
          Made by Gwendall
        </a>
      </footer>
    </main>
  );
}
