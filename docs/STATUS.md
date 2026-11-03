# Status

Updated 2026-11-03.

## Where it is

- Public since 2026-11-03: repository `gwendall/unheard` (MIT), site https://unheard.gwendall.com
  (Vercel, project `unheard`, production follows `main`). Web app (Next.js 16, React 19,
  Tailwind 4), analysis entirely in the browser (`lib/core`), three small API routes
  (`/api/aircraft`: adsb.lol with adsb.fi fallback, location rounded to 0.1°; `/api/weather`:
  Open-Meteo elevation and temperature; `/api/donate`: upload tokens for donated recordings,
  rate-limited by the Vercel Firewall at 10 per address per 10 minutes).
- Pipeline: RTS-smoothed ADS-B tracks, emission-time Doppler model (temperature lapse, wind
  supported but unknown in production), four-window evidence stack (2 s to 0.25 s, 20 Hz to
  3.8 kHz), sweep of tone (40 Hz to 2 kHz) and clock (±2 s), score against each aircraft's own
  wrong guesses, verdict strong / possible / none.
- Tests: unit (`pnpm test`), evals (`pnpm eval`, see `evals/README.md`), E2E in Chromium with a
  fake microphone (`pnpm e2e`).
- Open source: MIT `LICENSE`, `README.md` with the scoreboard and a "What it is not" section,
  `CONTRIBUTING.md` (four ways to help), `CODE_OF_CONDUCT.md` and `SECURITY.md` (reports to
  unheard@gwendall.com, or GitHub's private vulnerability reporting), `docs/OPEN-SOURCE.md`
  (phases, the go-public checklist as done on 03/11, listening station design). CI runs on
  GitHub's runners; workflows from outside contributors wait for a maintainer's approval.

## The product (redesign of 2026-11-03)

What a visitor goes through, and where it lives:

- **Home** (`components/Hero.tsx`, `app/[lang]/page.tsx`): the headline, one action (Listen to
  the sky), the example result as a card that opens it, what you need, the QR code for a
  computer, how it works in three steps as the visitor lives them, and "Does it work?" read from
  `evals/results.json` at build time. Once you have found planes, "Your planes" lists them.
- **The sky first** (`components/Listener.tsx`, `SkyList.tsx`, `lib/client/chance.ts`): before
  the microphone, the page shows the aircraft around you by their names (adsbdb), which one will
  pass closest and when, and says so in its headline. It watches for 10 minutes, then pauses.
- **A guided recording**: started when a plane is coming, it follows that plane's countdown and
  stops on its own once its sound has passed (30 s minimum, 5 min maximum).
- **The result** (`components/Result.tsx`): "It was a Cessna 172 Skyhawk." with the route, the
  registration and owner, a planespotters photo (`/api/photo`), six facts (distance, height,
  speed, sound delay, the hum's pitch, the Doppler fall), Hear it (the recording, then the plane
  brought out of it: sped up and band-passed, `lib/client/reveal.ts`), a share card
  (`lib/client/card.ts`, the phone's share sheet), a link to follow it live (globe.adsb.lol),
  the spectrum and the map, every plane checked, and the donation form.
- **Your planes** (`lib/client/logbook.ts`, `components/Logbook.tsx`): every real find kept in
  this browser's storage only, listed on the home, clearable.
- **Languages**, the way every site of the family has them (Koe, Wham, Kiku, istheinternetok):
  English at `/`, French at `/fr` (`/en` redirects to `/`). A first visit goes to the browser's
  first language; after that, to the one picked in the menu of the header or the footer (the
  `unheard-lang` cookie, English included). Link previews and crawlers get the page they asked
  for (`next.config.ts`). Every word lives in `messages/<code>.json`; `scripts/check-messages.ts`
  (in `lint` and `build`) holds each language to English's keys, lists and `{placeholders}`.
  French is written with plain spaces, `lib/typography.ts` puts the no-break ones.
  **Adding a language**: its `messages/<code>.json`, and a line in `LOCALES` and `LANGUAGES`
  (`lib/locales.ts`); the routes, the menu, the alternates and the check follow.
- **Installable**: `app/manifest.ts`, generated icons (`app/icon.tsx`, `app/apple-icon.tsx`).

## Results (2026-11-02)

See the latest reports in `evals/reports/` (regenerate with `pnpm eval`). Numbers below are
filled in from the runs of this date.

Thresholds: strong at score 9 and lead 2.5, possible at 6.5 and 1.5 (`lib/core/match.ts`).

| eval | scenarios | strong and right | any and right | strong but wrong | false strong |
|---|---|---|---|---|---|
| synthetic (SEEDS=60) | 72 heard, 60 empty | 0.29 | 0.42 | 0 | 0 |
| synthetic, CI corpus (SEEDS=30) | 36 heard, 30 empty | 0.39 | 0.50 | 0 | 0 |
| real-tracks (Phoenix, adsb.lol) | 34 heard | 0.47 | 0.59 | 0 | 0 |
| real-audio (AeroSonicDB, Adelaide) | 10 heard, 8 empty | 0.20 | 0.70 | 0 | 0 |

- Synthetic, by findability (oracle score with a perfect model): above 6, 23 of 23 named
  (18 strong), 0 wrong; 4 to 6, 4 of 6; under 4 (43 of 72, faint on purpose), 3.
- Nothing to find: worst score 8.19 (synthetic: a loud aircraft left out of the data and a
  decoy close to its curve), 4.41 on real audio. Strong starts at 9.
- Real audio: the Bell 412 helicopter twice (12.5 and 9.9, strong), a Cessna 172 (7.9),
  a Beech King Air (9.0), two 737s at 0.9 to 1.9 kHz (6.9 and 6.6), the second helicopter
  (EC135) when the Bell is left out; missed a Dash 8, a 737 and an E190 (scores 4.5 to 5.5),
  never a wrong name. The microphone position is only known to tens or hundreds of metres.
- Speed: median 0.7 s (real audio, 60 s clips) to 2.1 s (synthetic, 120 s) per analysis in
  Node on this Mac.

## Next

1. Founder: record real flybys with `?capture=1` on a phone (a light-aircraft field, a heliport,
   an approach path), fill `truth`, commit them to `evals/fixtures/real/`. First real phone data.
2. A silent aircraft can borrow part of a loud line: in the page's example, JET881 (no sound
   at all) scores 8.6 beside the Cessna's 12.7, and the worst synthetic case with the heard
   aircraft left out of the data reached 8.19. Strong at 9 holds on every eval today, with a
   thin margin. Fix in the matcher: score each candidate again on the frames the best match
   does not explain, or ask a curve to fit its whole audible span. Then lower STRONG.
3. Wind: Open-Meteo wind at 10 m and aloft into `Air.wind` (the synthetic eval shows wind costs
   about one score point at 8 m/s).
4. Two aircraft heard at once (two helicopters at Adelaide): say both when both curves stand out
   and do not overlap, instead of "none" for want of a lead.
5. Speed: the wide band costs about 4x; coarse-to-fine tone search if a phone takes more than a
   few seconds.
6. adsb.lol rate limit (about one request every 2 s per address): the API route must share one
   upstream poll per area across users (the site is public now; Vercel Hobby allows a single
   rate-limit rule, spent on `/api/donate`); ask adsb.lol for a key.
7. Product, next: a notification when a plane is about to pass close while the sky screen is
   open (Notification API: Android, computers, and iPhones with Unheard on the home screen); a
   result page with its own address to share as a link, beside the picture.

8. Locate me (core only, no UI yet; draft PRs #29 and the one stacked on it): where the phone
   was from the flyby and the tracks, without its GPS (`lib/core/trace.ts`, `lib/core/locate.ts`,
   evals `trace` and `locate`). Loud single flybys land within 100 m (median 89 m); real clips:
   4 of the 5 propeller and helicopter passes within 270 m, the four jets missed (their fan tones
   sweep faster than the trace follower). An answer scoring 12 or more was within 1 km every time.

## Needs the founder

- Commercial or not? AeroSonicDB (CC BY-NC), ADS-B Exchange samples and OpenSky restrict
  commercial use; adsb.lol (ODbL) does not. The evals use the restricted sets only locally.
- Request access to AeroSonicDB 3K (3,058 events): an email to its author with the project.
- Donations license: CC BY 4.0 for the sound, but the anonymised tracks come from adsb.lol
  (ODbL). Confirm the combination before the first release of the dataset.
- If it ever becomes commercial: adsbdb.com (names, routes) and planespotters.net (photos, credit
  and link required) are free services with their own terms; check them first.
