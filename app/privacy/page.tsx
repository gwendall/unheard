import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "What is sent · Unheard" };

const SECTIONS = [
  {
    title: "When you listen",
    body: [
      "Your recording is analysed on your phone and stays there. The page asks our server for the aircraft around you with your position rounded to about 10 km, and for the ground height and temperature with your position rounded to about 100 m. Unheard saves neither; the host's request logs keep them for a short time. To give the planes their names (airline, route, model), the page asks adsbdb.com about the aircraft around you by their codes, never with your position. Nothing else leaves your phone.",
    ],
  },
  {
    title: "When you give a recording",
    body: [
      "Only if you tick the box and press the button. Before anything is sent, your phone rewrites the recording's flight data so it shows the same scene nowhere and at no time: you are moved to 0° 0° at sea level, every aircraft keeps its position relative to you, the whole scene is turned by a random angle so that no runway or approach path gives the place away, the clock is moved to 1 January 2000, and the aircraft lose their address, flight number and registration (they keep their type, such as C172). The angle and the shifts are never sent.",
      "What is sent: the sound (8,000 samples a second, the rate the analysis uses), the anonymised flight data, the temperature, what the page answered, what you said you heard and your note, your browser's name and version, and your microphone's audio settings. Not your location, not the time, not your device's identifiers. The upload goes to a private store; your address is not saved with it.",
    ],
  },
  {
    title: "What happens to it",
    body: [
      "Each recording is checked by a program and then by a person before it joins the public dataset the project tests itself on. Parts with voices are cut out. The dataset is published under CC BY 4.0, so anyone may use it with credit.",
      "After sending, the page shows the donation's id. Write to unheard@gwendall.com with it to have the recording removed, before or after publication.",
    ],
  },
];

export default function Privacy() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-10 px-5 py-16 sm:px-8">
      <header className="flex flex-col gap-3">
        <Link href="/" className="text-xs font-medium tracking-[0.3em] text-amber uppercase">
          Unheard
        </Link>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">What is sent</h1>
      </header>
      {SECTIONS.map((s) => (
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
