// Every word the site shows, in English. fr.ts has the same shape (the type checks it): a key
// missing there fails the build.

export const en = {
  meta: {
    title: "Unheard: the plane you can't hear",
    shareTitle: "Unheard: your phone names the plane flying over you",
    description:
      "Hold your phone up to the sky for a couple of minutes. Unheard picks out the faint drone of a plane in the noise and tells you which plane it was, from live flight data.",
    ogLocale: "en_US",
    ogAlt:
      "There's a plane you can't hear. Your phone hears it. Unheard names it. A glowing amber tone bends down across a night-blue spectrogram, as the pitch of a passing plane does.",
    privacyTitle: "What is sent · Unheard",
  },
  og: { lines: ["There’s a plane", "you can’t hear."], sub: "Your phone hears it. Unheard names it.", size: 100 },
  hero: {
    title: "There's a plane you can't hear.",
    lead: "Your phone can. Unheard shows you the planes passing nearby, listens while one flies over, and finds its faint hum in the noise to tell you which plane it was.",
    listen: "Listen to the sky",
    needs: ["A phone, outdoors, and a minute or two", "Best with propeller planes and helicopters", "Your recording stays on your phone unless you choose to give it"],
    qrTitle: "Better on a phone, outdoors.",
    qrBody: "Point your phone's camera here to open Unheard on it.",
  },
  example: {
    label: "See an example result: a Cessna 172 Skyhawk found in a simulated recording",
    chip: "Simulated example",
    found: "Found it",
    verdict: "It was a Cessna 172 Skyhawk.",
    open: "See this example in full",
  },
  facts: {
    closest: "from you at its closest",
    above: "above you",
    delay: "for its sound to reach you",
  },
  how: {
    title: "How it works",
    steps: [
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
    ],
  },
  proof: {
    title: "Does it work?",
    lead: "Every change is tested on recorded flybys before it ships. One rule never bends: when Unheard says “It was”, it must be right.",
    wrong: (n: number, tested: number, nothing: number) =>
      `wrong ${n === 1 ? "name" : "names"} when it says “It was”, over ${tested} test recordings, ${nothing} of them with no plane to find. When the trace is faint it says “probably”.`,
    realValue: (hit: number, n: number) => `${hit} of ${n}`,
    real: (strong: number) => `real recorded flybys, near Adelaide, named right: ${strong} for sure, the others as “probably”.`,
    yoursValue: "Yours",
    yours: "Phone recordings are the next test. After a match you can give yours, with no place or time attached.",
    measured: (date: string) => `Last measured on ${date}.`,
    scoreboard: "Every number and how it is measured",
  },
  footer: {
    github: "Open source on GitHub",
    privacy: "Privacy",
    madeBy: "Made by Gwendall",
  },
  privacy: {
    title: "What is sent",
    sections: [
      {
        title: "When you listen",
        body: [
          "Your recording is analysed on your phone and stays there. The page asks our server for the aircraft around you with your position rounded to about 10 km, and for the ground height and temperature with your position rounded to about 100 m. Unheard saves neither; the host's request logs keep them for a short time. To give the planes their names (airline, route, model), the page asks adsbdb.com about the aircraft around you by their codes, never with your position, and Unheard's server asks planespotters.net for a photo of the one it found, by its code too. Nothing else leaves your phone.",
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
    ],
  },
};

/** A dictionary: en's shape, with every string widened (no literal types). */
type Widen<T> = T extends string ? string : T extends number ? number : T extends (...a: infer A) => infer R ? (...a: A) => Widen<R> : T extends readonly (infer U)[] ? Widen<U>[] : { [K in keyof T]: Widen<T[K]> };
export type Dict = Widen<typeof en>;
