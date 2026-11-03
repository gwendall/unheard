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
  wrong guesses, a check of the strongest against the lines heard in the sound alone
  (`lib/core/explain.ts`), verdict strong / possible / none.
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
- **Somewhere else** (`/somewhere-else`, `components/Elsewhere.tsx`, `lib/client/elsewhere.ts`):
  a voice note or an audio file gets the hum of the real planes flying over another place right
  now (one of 12 cities, one at random, or coordinates), as heard from a spot there, under the
  voice. Three polls, 3 s apart. Then Unheard's own analysis reads the downloaded WAV back at
  that spot and says how strongly it names the plane. Linked by one line under the home's
  example and one under the result's buttons. The recording never leaves the phone.

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
| real-audio (Livermore phone recordings, 2026-11-03) | 41 heard, 28 empty | 0.88 | 0.90 | 0 | 0 |

- Synthetic, by findability (oracle score with a perfect model): above 6, 23 of 23 named
  (18 strong), 0 wrong; 4 to 6, 4 of 6; under 4 (43 of 72, faint on purpose), 3.
- Nothing to find: worst score 8.19 (synthetic: a loud aircraft left out of the data and a
  decoy close to its curve), 7.88 on real audio (Livermore R08 without its PA-28: a Cessna 172
  1.2 km away, perhaps audible). Strong starts at 9.
- Real audio: the Bell 412 helicopter twice (12.5 and 9.9, strong), a Cessna 172 (7.9),
  a Beech King Air (9.0), two 737s at 0.9 to 1.9 kHz (6.9 and 6.6), the second helicopter
  (EC135) when the Bell is left out; missed a Dash 8, a 737 and an E190 (scores 4.5 to 5.5),
  never a wrong name. The microphone position is only known to tens or hundreds of metres.
- Livermore (Pathak 2026, CC BY 4.0, `node scripts/fetch-livermore.ts`): 40 phone recordings of
  aircraft 0.3 to 5.7 km away. 35 named for sure, 1 as possible, 0 wrong; the right aircraft
  ranks first in 39 of 40. Missed: R21 (a jet and a Cessna 172 heard at once, lead 1.4), R44,
  R50 (an EMB-145 5 km up), R51. Two false "possible" in 28 runs without the aircraft. The
  microphone is recovered from the published offsets (2 m rms), the start from the UTC ridge.
- Speed: median 0.7 s (real audio, 60 s clips) to 2.1 s (synthetic, 120 s) per analysis in
  Node on this Mac, before the line check of 2026-11-03, which about doubles it (Next #5).
- Somewhere else (2026-11-03, `evals/somewhere-else`, CI corpus: 15 made-up skies and 15 real
  Phoenix skies, voice notes of 30 to 60 s). The page's own check names the planted plane
  strongly in 0.90 of scenes, and never a plane it did not plant. With the true tracks of that
  minute instead of the page's dead reckoning: 0.83 (0.70 before the line check), and never a
  plane it did not plant. From 3 km away: 0. The planes sit 47 dB under the voice (median). At
  home, with home's own sky, one of home's planes is named strongly in 0.10 of scenes (0.37
  before the line check): see Next #2.

## Where and when: the flight history (2026-11-03)

The groundwork for "where and when was this recorded?" (colsto's idea): a day of low flights
anyone can fetch tile by tile. Format `docs/history-format.md` (v1, ODbL 1.0, "© adsb.lol
contributors"), builder `pnpm history:build <day> [--out dir]` (`scripts/history-index.ts`, any
machine with Node 22), reader `lib/history.ts` (takes a fetcher: the base URL is one setting).

- Proved on seven days (numbers in `evals/DATASETS.md`): a day's 3.2 to 3.9 GB tar is streamed,
  never stored, in 18 to 65 s, parsed in 86 to 218 s of worker CPU, written in 72 to 190 s, at
  most 3.8 GB of memory. It keeps about 47 M points of 58,000 aircraft a day, at or below
  10,000 ft. The world weighs 254 to 345 MB a day (125 to 202 MB without jets), the contiguous
  US 157 to 228 MB, Europe 52 to 67 MB. Tiles: median 8 kB, p99 1.8 MB, the busiest 4.7 MB
  (none passed 5 MB, so none was split). The Bay Area is 6.7 MB a day.
- Deterministic: the same day built twice gave byte-identical manifests (all 2,551 tile hashes).

What the web version needs (nothing created yet, no paid resource):

- A daily job: `pnpm history:build <yesterday>` once adsb.lol publishes the day (its release
  lands the next morning, UTC), then an upload of the day's folder. On a GitHub runner of this
  public repository (4 cores, 16 GB, free minutes) that is about 5 to 8 minutes.
- Storage: 8.7 GB a month for the world (4.8 GB without jets), 105 GB a year. At Cloudflare R2's
  list price (0.015 $ per GB-month, no egress fee, checked 2025) that is 0.13 $ after a month and
  about 1.6 $ a month after a year; the free 10 GB covers the first month. The US alone: 5.7 GB
  a month.
- Reads: a search of one day over a 100 km square fetches 4 tiles, about 7 MB (the Bay Area).
- In the page, one setting (say `NEXT_PUBLIC_HISTORY_URL`: the bucket, a folder served in
  development, or anyone's mirror) handed to `httpFetcher`.

## Where and when: the search (2026-11-03)

`lib/core/flyby.ts` (#39: each tone read as a straight pass), `lib/core/guess.ts` (#40: one spot
and start checked against the flights), `lib/core/wherewhen.ts` (the search), all without DOM;
`pnpm where <audio> --day <day> --near lat,lon [--radius km]` (`scripts/where.ts`, builds a
missing day first); eval `evals/wherewhen.eval.ts`. Given a recording, a UTC day and a square, it
returns ranked spots with a start time, the aircraft that explain each tone, the mirror spot, and a
flag raised only when two flyovers by two aircraft, heard apart, agree on one spot and one start,
one aircraft ahead of every other answer.

Measured (Livermore: the 40 phone recordings, day only, squares centred on Oakland; Node on the
founder's Mac while other sessions loaded it to a load average of 100 to 600, so times are CPU
time; wall time ran 2 to 20 times longer):

- One recording, one aircraft, 100 km square (29 of the 40; the rest did not finish on the loaded
  Mac): median error 29 km, p90 66 km; one within 1 km (R05: 512 m, start 7 s off), none within
  500 m; all flagged unsure. 300 km (8 of them): none within 1 km, all unsure. One flyover is not
  enough over a whole day: on R01 about 4,900 other aircraft, spots and starts fit its one pass
  better than the truth.
- Two recordings made at one site under 30 minutes apart (two flyovers), 100 km, 18 pairs: 2
  found (28 m and 1 s; 129 m and 0.7 s), a third with the truth as its second answer (164 m,
  5 s), the rest 9 to 79 km off; all flagged unsure. 300 km (3 pairs run): none within 1 km.
- colsto's hour (Oyster Bay, 2026-09-08, 100 km square, 65 tones): best answer 64 km off, flagged
  unsure, 372 s. At the truth the reading is right: a Cessna 208 at 8.4 km, a Piper PA-30 at 8.2 km
  and the Beech 350 at 3.6 km explain their tones (misfit 0.07 to 0.12), no aircraft passed close
  unheard, evidence 2.31, above every spot found (best 1.63). But no candidate lands within 500 m
  and 30 s of it. The Pilatus PC-12 his video names never comes within 70 km of the spot in the
  index (part of its flight is above the index's 10,000 ft ceiling).
- The flag: raised 0 times in 59 runs, so never wrong, but it stayed down on the 3 answers
  within 1 km too (their lead over the next spot was under one aircraft).
- Time and memory: a 2-minute clip at 100 km (R01 from the command line, 1,615 flights, 143,000
  candidates) takes 22 s of CPU and 0.4 GB, decoding and traces included; the eval's recordings
  take about 20 s of CPU each. colsto's hour: under 4 minutes of CPU in all (its 65 traces found
  chunk by chunk, 3 M candidate reads), 2 GB. A phone runs this JavaScript perhaps 2 to 3 times
  slower (not measured yet): about a minute for a clip, too long for an hour.

Why it does not find more yet (measured):

- The lead is rough on real passes and the search only looks where it points. The straight-pass
  fit misses the ADS-B ground speed by more than 4 m/s in 8 of 35 Livermore recordings (the
  Doppler sees airspeed: wind; turns), the closest moment by up to 10 s (p90; 12 s on colsto's
  Beech), and colsto's Piper, 8 km away and turning, reads as a pass at 45 to 665 m. Widening the
  clock to 12 s and letting the open tones raise candidates (tried on colsto: 4.6 M candidates)
  still put none near the truth, and let a wrong spot reach 2.37.
- When the truth is among the candidates, it does not stand out: on R23 + R22 the truth is the
  best spot before the fine search (evidence 1.77, 164 m, 5 s) and a spot 40 km away reaches
  1.78 after it. Busy Bay Area or Long Island traffic over 24 hours offers a near-equal
  explanation almost anywhere.
- Next, in order: a window of an hour (a file's date, or the user's "this afternoon") cuts the
  rivals by 24; candidates from the real tracks instead of the straight-pass lead (every aircraft
  within 10 km, on a coarse grid of spots and starts); measure what a ceiling of 15,000 ft adds to
  the index for turboprops.

What the web version needs:

- The history (above): a daily job and a bucket, about 0.13 $ after a month.
- The search in a Web Worker (`lib/core` runs as is, `onProgress` reports the stage): about 7 MB
  of history tiles and about 1 MB of terrain tiles for a 100 km square (Terrarium PNGs from the
  open AWS bucket, zoom 10; check their CORS or mirror them beside the history).
- A day (from the file's date when it has one, narrowed to the hour when possible), a square on a
  map, the answers with their aircraft and mirror, and "not sure" unless the flag is up, which
  today is always.
- The file's date: `lib/client/metadata.ts` (no UI yet) reads when, where and on what device from
  an MP4, MOV, M4A, WAV or MP3 without loading it; not GPS in timed tracks (GoPro, drones), so an
  empty answer does not mean the file says nothing.

## Next

1. Founder: record real flybys with `?capture=1` on a phone (a light-aircraft field, a heliport,
   an approach path), fill `truth`, commit them to `evals/fixtures/real/`. First recordings
   made through the page itself.
2. Done 2026-11-03 (`lib/core/explain.ts`): a loud line from a plane missing from the data no
   longer makes a plane of the data strong. Every aircraft that could be strong is checked
   against the lines heard in the sound alone (blind traces): one whose curve follows only a
   stretch of a line, where a straight flyby that follows the same stretch follows a good part
   of the rest, is scored again without that line. At home with home's own sky, a strong in 3 of
   30 scenes (was 11); with the true tracks at the fake spot, 0.83 strong and right and never a
   plane that was not planted (was 0.70, and the E145). Nothing lost on the synthetic,
   real-track and real-audio evals. Left, the three home strongs: home's plane runs along the
   planted line within 2 % for all of it (synthetic-3, phoenix-9-25, tracks known throughout),
   or for 32 s of a 58 s line, wherever its track is known (phoenix-6-22). The curves cannot
   tell these apart; the next signal is the level (how loud a line can be from a plane that
   far). STRONG stays at 9 until then. `analyze()` returns `unexplained`, the lines no aircraft
   of the data explains (a plane we hear that the data does not have), for the page to say so.
3. Wind: Open-Meteo wind at 10 m and aloft into `Air.wind` (the synthetic eval shows wind costs
   about one score point at 8 m/s).
4. Two aircraft heard at once (two helicopters at Adelaide, a jet and a Cessna in Livermore
   R21): say both when both curves stand out and do not overlap, instead of "none" for want of
   a lead.
5. Speed: the wide band costs about 4x, and the line search of the check (blind traces up to
   2 kHz) about twice the evidence stack (16 clips under load: stack 1.2 s, matcher 0.9 s, lines
   2.3 s, check 0.2 s); coarse-to-fine tone search, or lines only near the candidates' tones, if
   a phone takes more than a few seconds.
6. adsb.lol rate limit (about one request every 2 s per address): the API route must share one
   upstream poll per area across users (the site is public now; Vercel Hobby allows a single
   rate-limit rule, spent on `/api/donate`); ask adsb.lol for a key.
7. Product, next: a notification when a plane is about to pass close while the sky screen is
   open (Notification API: Android, computers, and iPhones with Unheard on the home screen); a
   result page with its own address to share as a link, beside the picture.

8. Locate me (core only, no UI yet; draft PRs #29 and #30): where the phone
   was from the flyby and the tracks, without its GPS (`lib/core/trace.ts`, `lib/core/locate.ts`,
   evals `trace` and `locate`). Loud single flybys land within 250 m 5 times in 6 (median
   123 m); real clips: 6 of 10 within 1 km (median 840 m), 2 of the 4 jets within 70 m now that
   their fan tones above 2 kHz are searched and a loud trace stops where its tone fades. An
   answer scoring 12 or more was within 1 km every time. Medium-loud synthetic flybys (oracle 6
   to 10) still give a right trace 2 times in 10: a slower, longer-integrating search did not
   find more without false traces in noise.
9. Where and when (core and command line, no UI yet): two flyovers at one spot are found 2 times
   in 18 at 100 km, one alone never; next a window of an hour and candidates from the real
   tracks (section "Where and when: the search").

## Needs the founder

- Commercial or not? AeroSonicDB (CC BY-NC), ADS-B Exchange samples and OpenSky restrict
  commercial use; adsb.lol (ODbL) and the Livermore recordings (CC BY 4.0) do not. The evals use the restricted sets only locally.
- Request access to AeroSonicDB 3K (3,058 events): an email to its author with the project.
- Donations license: CC BY 4.0 for the sound, but the anonymised tracks come from adsb.lol
  (ODbL). Confirm the combination before the first release of the dataset.
- If it ever becomes commercial: adsbdb.com (names, routes) and planespotters.net (photos, credit
  and link required) are free services with their own terms; check them first.
