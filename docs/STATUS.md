# Status

Updated 2026-11-04.

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

- **Home** (`components/Hero.tsx`, `app/[lang]/page.tsx`): the hero is the file. "Where was this
  filmed?" with the drop zone right there and the whole page taking a drop; a file goes on to the
  one flow at `/where`, in memory (`lib/client/held.ts`), and the heading and the card stay where
  they are (`components/DoorHeader.tsx`, checked by rect). "Listen to the sky" is the clear second
  door: on a computer it opens the QR code first, on a phone it starts at once. Below: the example
  result as a card that opens it, how it works in three steps, and "Does it work?" read from
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
- **Not in the flight data** (`Ghosts` in `components/Result.tsx`): when `analyze().ghosts` holds a
  line, one quiet block after the verdict says when it is heard, the pitch it falls through, the
  speed and closest distance a straight pass implies as an order of magnitude, and that it may be a
  plane with no transponder or another moving sound. The spectrum draws it as dashed rails. It
  never changes the verdict and stays out of the share card.
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
- **One flow for a file** (`/where`, `/check` redirects there; `components/Where.tsx`,
  `components/Drop.tsx`): the file state takes the drop zone's place, the header stays put, and the
  whole page takes a drop. In order, each as soon as it is known: what the file says about itself
  (`lib/client/metadata.ts`: GPS first and big, then date, time, device), its aircraft tones, each
  as it is found (its curve at once, its picture at the end), in the file's order, with a one-line verdict, then two actions side by side, "Find where" and "Take them out", and the link
  to Somewhere else. "Find where" is there from the start and waits for nothing. The search reads the sound once per file, at 8 kHz (`soundOf`, a stream where it can be), and the check reads it into its own store; a running search stops the check, shows the tones it finds in the check's place, and the check starts again after it, so a phone never does both. The 48 kHz sound is decoded only when "Take them out" is pressed. A clear state for each failure: no sound (`check.errors.open`), a file past 2
  GB that can only be opened whole (`lib/client/decode.ts`), no tone (no action offered unless a search is already open, and never "safe"), a day not in the
  archive, no flight fitting. With no tag found it says only that, and that some cameras keep GPS
  where we do not look, never that the file is silent. The verdict and actions keep their places as
  results arrive, checked by rect in `e2e/where.spec.ts`; "What we check" comes back under the card
  once the tones are known, so nothing jumps (layout shift 0 from the home to the tones, same spec).
  Find where puts the focus on the first gap, and on no field on a touch screen.
  With a file in, the header drops its lead and keeps the heading, which does not move, and one line of privacy. Once a search has its answer, the answer comes first, the file's own findings under it, on both widths: "Find where" gives way to "Change the search", the file's actions go quiet, and "Share this result" is the one primary. A search's end brings the verdict into view, instantly under reduced motion, unless the visitor has scrolled away.
- **Take them out** (`components/Check.tsx`, `lib/client/check.worker.ts`,
  `lib/core/leak.ts`, `lib/core/stream.ts`, `lib/client/media.ts`): the defence colsto's viewers
  asked for ("what's the counter strat?"). A worker reads the video or sound file as a stream
  (Mediabunny and WebCodecs, 8 MiB of the file at most in memory; Web Audio in the page, the whole
  file at once, only for a container or a codec that cannot be streamed) and keeps its sound at
  8 kHz in the browser's private files (`lib/client/disk.ts`; in memory where there are none, 115 MB
  an hour). It searches that for aircraft tones with no flight data (findTraces over overlapping
  3-minute chunks; it reports 40 to 400 Hz, and takes out with those tones what it finds up to
  3.4 kHz in the same chunk). "Take them out" runs the rounds of take out and look again on that copy
  (scrub, the emptied band filled with noise at its neighbours' level), then takes every curve out of
  the file's own sound in one more pass, 20 s at a time, and searches what comes out again: that is
  what is shown before and after and downloaded as a WAV, written to the private files as it goes.
  Nothing leaves the device; those files go when the visitor moves on, or on a later visit if a tab
  died. Measured by `evals/leak.eval.ts`, which runs that same path: on AeroSonicDB, tones found in
  9 of 9 clips, 6 named before, none after.

- **Find where** (`components/FindWhere.tsx`, `components/PlaceMap.tsx`,
  `lib/client/where.ts`, `lib/client/where.worker.ts`): a spot and a start
  time out, in the browser. It asks only what is missing: the day and hour come filled in from the
  file (the page says from which tag), and roughly where is a town offered as you type (`searchPlaces`,
  our own gazetteer), coordinates, or "Use my location" (a 100 km square); with nothing missing it
  goes straight to the search. The sound
  is decoded at the analysis rate, then a worker finds the tones, fetches that day's tiles for the
  area, and runs `whereWhen`, with one bar and the time left for the whole job (`lib/core/progress.ts`),
  the best guess so far, hedged, as soon as there is one, and a way to cancel; the tones and
  "Take them out" stay usable meanwhile. "Probably here" only under the confidence flag, else "Best guess" and
  up to two more answers; the map (`SpotPlot` only as its fallback), the start in UTC and local time, each plane with its registration
  (the history keeps no callsign), type, distance and passing time, its spectrum with the curve.
  A share card (`lib/client/where-card.ts`, the same `drawCard`) holds the plot, one curve, the place
  and the time; it is drawn only on the sharer's click, and nothing is sent until they choose where.
  The answer leads with the town nearest it (`nearestPlace`, "Near Oyster Bay, New York", waited for
  1.5 s at most so the answer arrives whole), coordinates second, and the answers' chips read as town
  names. Local time comes from that town's zone; a local hour with typed coordinates asks the nearest
  town when the search starts, the same square it reads; the longitude only when no name answers.
  - **The flight archive is one setting**, `NEXT_PUBLIC_HISTORY_URL` (`lib/archive.ts`, read at
    build time): without it the page says the archive is not connected and offers no search; what
    a file says, its tones and taking them out still work. On production it is `https://unheard-history.t3.tigrisbucket.io` (no trailing slash;
    see "Hosting" in `docs/history-format.md`). The day is picked among those in the archive's
    `days.json`, and the page says each day's flights arrive the next day. It goes back to
    `OLDEST_DAY` (`lib/client/where.ts`, the job's `OLDEST`). A day with an empty manifest counts as
    missing, not as a day without flights (2026-05-05: a release with no traces).
    A file's date that is not covered is said, with the days there are; before `OLDEST_DAY` it is
    told the archive will not reach it.
  - **Sure or not**: "Probably here" only on `whereWhen`'s flag, which in practice never rises (0
    of 42 searches at MARGIN 8), so the usual result is "Best guess". It leads with the spot, the
    start, the flyovers it explains and which planes, then the next distinct answers and how far
    off they are (the lead stays on the best guess while they are looked through). Every word
    stays a guess ("Would have started", "Guess" on the plot), even when it is the right spot:
    colsto's hour window found the spot within 55 m with the flag down. The one honest line,
    `where.result.honest`, quotes the eval (8 of 20 pairs with the hour, 6 of 20 with the day):
    update it with the eval.
  - **Terrain**: AWS's open terrain tiles allow browsers (`access-control-allow-origin: *`, checked
    03/11), so the search uses real ground height, and falls back to flat if a tile fails.
  - **Place names**: `lib/client/places.ts` (`nearestPlace`, `searchPlaces`, `placeLabel`), an offline
    gazetteer from GeoNames in the bucket under `places/v1/`, so naming a spot or typing a town
    reaches no third party. Layout, the build and the upload: `docs/places-format.md`.
  - **The map**: `components/PlaceMap.tsx` (a thin shell), `components/PlaceMapCanvas.tsx` (MapLibre, in
    its own chunk, loaded when a result appears), `lib/client/map-style.ts` (the site's palette) and
    `lib/client/map-overlay.ts` (the marks). One PMTiles file of the planet in our bucket, read by
    range requests; fonts and sprite there too; nothing asked of OpenStreetMap or anyone else. No
    WebGL, or tiles that cannot be read: `SpotPlot` in the same box. `/en/dev-map` shows it in
    development (404 in production). Size, cost, refresh: `docs/map.md`.
  - **Development**: `next dev` defaults to `/dev-history` (`app/dev-history`, 404 in production),
    which serves `e2e/history` or `DEV_HISTORY_DIR` (say `evals/.cache/history`). `e2e/where.spec.ts`
    runs a made-up recording over one committed tile: 70 minutes of real adsb.lol flights (ODbL)
    around a spot `scripts/make-where-fixture.ts` picked, one aircraft in eight plus those heard.

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
  Measured with `pnpm speed` (Node, CPU time, golden comparison of results) and `pnpm
  speed:browser` (real Chromium: time to the verdict, memory, first load). Baseline 2026-11-04,
  main at d7d87c5: an 85 s file checked in 5.4 s CPU, a 10 minute file in 42.7 s (536 MB of JS
  heap), a real 60 s 22 kHz clip with 11 curves in 50 s, of which taking them out is 74 %.
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

Online since 2026-11-03 at https://unheard-history.t3.tigrisbucket.io/ (public Tigris bucket, daily job on a scheduled Fly Machine, "Hosting" in `docs/history-format.md`): 2026 is all there since 2026-11-04, built in 3 h 45 by one-day one-shot Machines (the founder put speed ahead of the cost: about 7.40 USD once, estimated from list prices, so about 10 USD in November, past the 5 USD a month); then about 3 USD a month, which storage brings to 5 USD a month around the end of 2027. 89 GB, 304 days of flights, gaps in "Hosting" in `docs/history-format.md`.

What the page still needs:

- Reads: a search of one day over a 100 km square fetches 4 tiles, about 7 MB (the Bay Area).
- In the page, one setting, `NEXT_PUBLIC_HISTORY_URL` (the bucket above, a folder served in
  development, or anyone's mirror), handed to `httpFetcher`: built, see "Where was this recorded?"
  above.

## Where and when: the search (2026-11-03)

`lib/core/flyby.ts` (#39: each tone read as a straight pass), `lib/core/guess.ts` (#40: one spot
and start checked against the flights), `lib/core/tracks.ts` (the guesses, from the real tracks),
`lib/core/wherewhen.ts` (the search), all without DOM;
`pnpm where <audio> --day <day> --near lat,lon [--radius km]` (`scripts/where.ts`, builds a
missing day first); eval `evals/wherewhen.eval.ts`. Given a recording, a UTC day and a square, it
returns ranked spots with a start time, the aircraft that explain each tone, the mirror spot, what
the answer is worth against the size of the search, and a flag raised only when two flyovers by two
aircraft, heard apart, agree on one spot and one start, worth 8 nats more than the search's size
and 3 ahead of every other answer. `--from` and `--to` narrow the day to an hour.

How a guess is made: one tone per flyover heard; for each tone and each flight in the window, the
clock slid along the flight's real curve (turns, speed, height, terrain) from spots sampled around
its track; a fit is worth how rarely one that good happens at a random spot and second; the flyovers
must agree on one spot and one start, read exactly; silence prunes the rest; `locate()` does the
fine search.

Measured (Node on the founder's Mac, shared with other sessions, so times are CPU time; 100 km
squares, a start within 30 s for every "within"):

| | before, day | day | hour |
|---|---|---|---|
| colsto's hour, best answer | 64 km, 24 min | 39 km, truth second (164 m, 2 s) | 55 m, 0.9 s |
| colsto's hour, CPU | under 240 s, 2 GB | 206 s, 1.5 GB | 35 s, 1.6 GB |
| Livermore pairs, within 250 m | 2 of 18 | 6 of 20 | 8 of 20 |
| Livermore pairs, truth among the answers | 3 of 18 | 6 of 20 | 9 of 20 |
| Livermore pairs, median error | 9 to 79 km when missed | 19 km | 12 km |
| Livermore pairs, CPU p50 | about 20 s a recording | 48 s | 13 s |

- An hour instead of a day: 2 more pairs of 20 and colsto's truth from second answer to first, for
  a quarter of the CPU. It is worth 3.2 nats (ln 24).
- The day still misses most pairs (14 of 20) and the hour 12 of 20. colsto's hour is found because
  3 flyovers are read well there: a Cessna 208, a Piper PA-30 and the Beech 350.
- Memory: 0.6 to 0.9 GB for a pair in Node, 1.6 GB for colsto's hour, whose stacks are held whole. A
  phone is perhaps 2 to 3 times slower and tighter on memory: not measured.
- One recording alone (before, day): median 29 km, one within 1 km of 29. See below for why this
  cannot improve much; its rerun goes here when it is done.
- The flag: raised 0 times in 42 searches of pairs and colsto, so never wrong, and down on all 15
  right answers. Raised at 3 nats over the search, it was wrong on colsto's day (39 km off, 5.6 nats
  over, 3.1 ahead of the truth), so it now takes 8. It does not earn its keep yet.

Why it does not find more yet (measured):

- Physics: over a day at 100 km the search is 19.7 nats (spots and starts at 500 m and 10 s), an
  hour 16.5, and one flyover read very well gives 6 to 12. One flyover cannot be told from chance,
  two are about even over a day.
- The data: in 8 of the Livermore recordings the lead tone cannot read at the truth for want of
  points: the flight has a gap over 60 s in the index around the pass (R08, R24), no points near it
  (R13, R17, R50), points only from 17 s on (R44), or its closest moment outside the clip (R57, R59).
- The lead tone: one tone per flyover, the most confident. On R03 it jumps a harmonic (211 to 102
  Hz), on R02 it runs past the flight's data, while a weaker tone of the same flyover reads 0.17 and
  0.33 at the truth. Up to two tones per flyover is the next thing to try.
- A lucky fit can lead, as on R40 + R23 over a day. Capping a fit's worth at a loss of 0.1 finds
  that pair and misses another (still 6 of 20) but loses colsto's hour (truth second, 250 m).
  Scanning only the distances a tone's steepest slope allows saves 10 to 25 % of the CPU and, with
  the cap on, drops colsto's truth to 11th. Both left out.

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

## The level of a tone (2026-11-04)

Can how a tone rises and falls tell the plane that made it from a plane whose curve merely follows
it? A phone's gain does not matter for the shape, and a far plane's range barely moves. Measured by
`evals/level.eval.ts` (real audio, the heard plane best at score 9 or more, 36 recordings with a
line to read). **It does not hold, and no verdict reads it.** A window here is a stretch of the level
along the whole recording's curve, not `analyze()` run again on that cut.

| window | level swing, dB, p50 / p90 / max | same, where the range moves under 1.5 dB | swing veto, margin to lose nobody, dB | far plane it catches | flyby veto, margin to lose nobody, dB rms | far plane it catches |
|---|---|---|---|---|---|---|
| whole | 18.7 / 25.0 / 37.8 | none | 6.1 | 0.11 | 0.55 | 0.53 |
| 60 s | 15.8 / 23.1 / 40.0 | none | 19.3 | 0.00 | 1.13 | 0.22 |
| 45 s | 14.8 / 23.1 / 43.2 | 13.0 / 23.2 / 32.3 | 26.6 | 0.00 | 1.34 | 0.12 |
| 30 s | 12.2 / 20.3 / 45.4 | 9.8 / 19.3 / 36.0 | 30.6 | 0.01 | 3.08 | 0.01 |

- Right planes do follow their range, at 2.6 times its swing (median, up to 7 times), and far more
  loosely than the physics reads: 4.9 dB rms around their own range, 6.1 around a far plane's. Where
  the range barely moves they still swing 10 dB over 30 s, up to 36. colsto's Cessna 208, 8.4 km
  away, swings 22 dB while its range moves 3.2. Directivity, the ground and the air swamp it.
- The swing veto (level past 5 times the range's) loses nobody only past margins no wrong line
  reaches. The wrong strongs swing 2.7 to 4.6 dB: their planted lines are made-up sound that falls
  as 1/r near a steady distance, quieter than a right plane's own wobble. It catches 0 of the 6.
- The flyby veto (the line's own straight flyby explains the level better than the plane's range)
  catches phoenix-6-22 at the margin of its length, and not phoenix-9-25 (1.5 dB rms, margin 3.08)
  nor synthetic-3 (no difference). The E2E's JET881 has no line to read at all.
- Two lines of one recording, against their planes' ranges: one recording of 49 has two to read
  (Bell 412 and EC135, correlation 0.00). Nothing to calibrate on, and the wrong strongs have one.

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
   tell these apart, and the level does not either (section "The level of a tone"). STRONG stays
   at 9. `analyze()` returns `unexplained`, the lines no aircraft
   of the data explains, and `ghosts`, those a visitor can be told (`GHOST` in
   `lib/core/explain.ts`, measured by `evals/ghost.eval.ts`): the flyby follows 80 % of it,
   confidence 20, no aircraft of the data follows half of it at any tone, read as a straight pass
   it is 300 m away or more. Told on 1 of 276 recordings with nothing to find (0 of 90 voice notes,
   1 of 107 stretches of street sound a human labelled free of aircraft, and that one looks like a
   far plane), 3 of 190 on the same street cut to 60 s; never with the heard plane in the data
   (0 of 191); 23 of 38 real planes left out of the data, always the right line, read within a
   factor of 2 in speed 28 times in 28 and in distance 25 in 28. Left: a line the data's other
   planes could follow at some tone is not told, so a busy sky hides it; and in the E2E's made-up
   sky, the heard plane left out, a jet at 31,000 ft can still go strong (9.2 to 9.5 on 3 of 50 cuts, 9.9 on one noted before)
   (`none` or `possible` on other cuts of the same recording), with no line found and 6.8 to 9 s of
   its curve known, since its sound takes 45 s to arrive: the matcher's limit, not changed. See
   item 10.
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
9. Where and when (core and command line, no UI yet): guesses come from the real tracks. Two
   flyovers at one spot are found 6 times in 20 over a day at 100 km, 8 in 20 over an hour; colsto's
   hour to 55 m with an hour given. Next: two tones per flyover, a flag that can be raised (section
   "Where and when: the search").

10. "Strong must never be wrong", what is left after the level:
   - The jet of the E2E's recording: strong on 6.8 to 9 s of known curve (3 of 50 cuts, polls only from
     the first sample; 0 of 50 with 10 s of polls before). The shortest curve of a strong and right plane is
     23.5 s, on 119 of them across real audio, synthetic, real tracks and somewhere else (colsto's
     strongs: 100 s). A floor of 15 s of known curve would take those three out with nothing lost:
     a small lot of its own, not the level.
   - At home with home's sky, 3 of 30 stay strong (synthetic-3, phoenix-9-25, phoenix-6-22). Nothing
     found in the sound tells them apart.
   - colsto's hour read in cuts of 2.5 minutes (`evals/level.eval.ts`): 9 strong in 30. Three are
     flyovers the where-and-when search also reads (Cessna 208, PA-30, Beech 350), two an R44 4 km off.
     Three are jets 12 to 13 km away at 71 to 144 Hz (F900, E170, CRJ9), and one an A220 at 49 Hz: no
     truth for them. A far plane's nearly flat curve may fit a slowly drifting sound. Worth a look
     before saying strong is never wrong on real audio: no eval has a truth here yet.

## Needs the founder

- Commercial or not? AeroSonicDB (CC BY-NC), ADS-B Exchange samples and OpenSky restrict
  commercial use; adsb.lol (ODbL) and the Livermore recordings (CC BY 4.0) do not. The evals use the restricted sets only locally.
- Request access to AeroSonicDB 3K (3,058 events): an email to its author with the project.
- Donations license: CC BY 4.0 for the sound, but the anonymised tracks come from adsb.lol
  (ODbL). Confirm the combination before the first release of the dataset.
- If it ever becomes commercial: adsbdb.com (names, routes) and planespotters.net (photos, credit
  and link required) are free services with their own terms; check them first.
