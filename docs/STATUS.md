# Status

Updated 2026-11-04.

## Where it is

- Public since 2026-11-03: repository `gwendall/unheard` (MIT), site https://unheard.gwendall.com
  (Vercel, project `unheard`, production follows `main`). Web app (Next.js 16, React 19,
  Tailwind 4), analysis entirely in the browser (`lib/core`), three small API routes
  (`/api/aircraft`: adsb.lol with adsb.fi fallback, one shared poll per 0.25° square,
  `lib/area.ts`; `/api/weather`: Open-Meteo elevation and temperature; `/api/donate`: upload tokens for donated recordings,
  rate-limited by the Vercel Firewall at 10 per address per 10 minutes).
- Pipeline: RTS-smoothed ADS-B tracks, emission-time Doppler model (temperature lapse, wind
  supported but unknown in production), four-window evidence stack (2 s to 0.25 s, 20 Hz to
  3.8 kHz), sweep of tone (40 Hz to 2 kHz) and clock (±2 s), score against each aircraft's own
  wrong guesses, a check of the strongest against the lines heard in the sound alone
  (`lib/core/explain.ts`), verdict strong / possible / none.
- Tests: unit (`pnpm test`), evals (`pnpm eval`, see `evals/README.md`), E2E in Chromium with a
  fake microphone (`pnpm e2e`). CI runs the E2E on every pull request (job `e2e`, 5 minutes): Chromium,
  and the cleaned video in Chrome, Firefox and WebKit.
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
- **One answer for a file** (`components/Answer.tsx`, drawn once by `components/FindWhere.tsx` from the first moment to the last, so that what stays is the same element and a click on it is never lost): one shape in every case, a map or a `?` box, one sentence, one date, what to do, and the rest under "Details" (`answer-details`, drawn on first open). A file with GPS: a map at the area's zoom (`REGION_ZOOM` = 11 in `components/Where.tsx`) with the pin drawn in the browser, "This file says it was filmed near <place>" and "The file says <date>" (tags can be edited or copied, so a tag is never stated as fact), the date in the place's own words, and "Download without its tags" as the primary. Measured on the bucket's byte ranges (Paris and Mesa, 1440 and 390 px): one leaf directory and 2 to 6 z11 tiles at first paint, a block 26 to 49 km wide, no finer tile and no fit or flight closer until the visitor zooms (one click: z12); `answer-map-note` says so in plain words, and `e2e/place-map.spec.ts` holds the zoom. A place named under the rule: "Probably filmed near <place>", date and local time, one row per plane, Share. Too few or none: "Can't tell where this was filmed", one short sentence, with cleaning and "search anyway" quieter. While the check runs: "Listening for planes in the sound" and a bar, no number or step. The sentence's, reason's and actions' boxes hold their height, checked by rect at 1440 and 390 px in both languages (`e2e/where.spec.ts`); a map's full credits sit at the answer's foot (`CreditSlot`), its corner says OpenStreetMap.
  "Too few" comes with no click and no search, and only from the search's own count: the check's count (cut its own way) only says a search is worth it, and when it falls under `MIN_PASSES` on a file with no GPS the check's worker runs the search's first steps on the same samples (`refusalOf`, then `soundGate` in `lib/client/where.ts`, which `where.worker.ts` reads too). On the eval's files the check's count alone would have refused files the rule goes on with (two pairs of recordings, check 2, rule 3). A sound decoded by the page (Web Audio) can differ from the search's, so there only the search says too few, after the click.
- **A plane's own sound** (`components/PlaneRows.tsx`): each row of a named answer plays the file's own 40 s around that plane's closest moment, faster and filtered to the band of its tone (`lib/client/reveal.ts`, as the listener's "Hear it"), nothing synthesised beyond what the file holds, one at a time. Rendered before the click, so that a phone's browser lets the click start it.
- **The example** (`/example`, `lib/client/where-example.ts`, `scripts/make-where-example.ts`): for whoever has no file to hand, "See an example" under the drop zone and on a "can't tell" opens the page of `/where` with a simulated file already in it, made in the browser from five real tracks (adsb.lol, ODbL) at a public spot, then read by the same search on the same archive under the same rule: nothing about the result is written in advance, and a change to the rule that stops naming it shows in `e2e/where-example.spec.ts`. "Simulated example" and the line "Simulated: real planes, made-up sound, mixed to show a clean case. None of our real test recordings got a place: they get "Can't tell"." stay on screen from the first moment (the count behind it: under the rule at 100 km with the hour known, 0 of the 40 single recordings and 0 of colsto's nested cuts got a place, and the 12 of 112 named files are all stitched groups; its loudness and seed were picked to get a name, 1 mix in 8 at this spot); no Share there, since a card could pass as a real find. The spot is the middle of Longbow Golf Club in Mesa, not the test scene's spot (a street address). Which places get a name is not plain from their distances: Falcon Field's runways and park, the golf course's other points and most mixes of loudness are refused, since it takes three planes heard very well at times apart. A new spot is checked with `pnpm where` on the real archive and in each browser. On a phone's first screen too: at 390x660 the door is its button, the formats line goes, and the lead takes a shorter sentence (`where.leadShort`); from 640 px nothing changes.
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
  Only the three strongest tones are on the page, in the file's order, during a search, after one and without one, and "See all N tones" under them: a real hour holds dozens, each a tall panel, and the others are not drawn until opened (`Folded` in `components/Check.tsx`). A result keeps them all collapsed under the answer.
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
  what is shown before and after and written to the private files as it goes. A video comes back as
  a video (`lib/client/remux.ts`, MP4, MOV, WebM, Matroska): the same packets, never re-encoded, under
  the cleaned sound (AAC or Opus from the browser's encoder, AAC from a WebAssembly one where it has
  none, loaded only then), in a new file with no tag, no date and no other track; the page names what
  was left out. A sound file comes back as a WAV, and so does a video the browser cannot write (MPEG-TS,
  AVI, no encoder), with one line saying why. A video with no sound track says so.
  The verdict and the tones go to the page as soon as they are known; a tone's pictures are drawn
  when the page shows it (the three strongest, the others when opened), the "before" from a copy of
  the sound made when taking out starts, so nothing waits for them.
  Nothing leaves the device; those files go when the visitor moves on, or on a later visit if a tab
  died. Measured by `evals/leak.eval.ts`, which runs that same path: on AeroSonicDB, tones found in
  9 of 9 clips, 6 named before, none after. On the Livermore set, phone recordings of planes passing within 6 km, 36 named before and 8 after: the tone is gone from a blind search, not from what someone with the flight data can add up, and the page says so with these numbers (`check.goneText`). On a 30-minute, 1.83 GB video in Chrome the browser peaks
  at 1.7 GB finding its tones and 2.2 GB taking them out (5 GB and 4.5 GB when the file was decoded whole).

- **A copy without its tags** (`lib/client/strip.worker.ts`, `planCopy` and `writeCopy` in
  `lib/client/remux.ts`): offered under what the file says, the part of the panel the check never changes, from the moment the
  file is known to hold a tag that says more than the software's name, or a track beyond the picture and the first sound, with or
  without a tone or a sound. Its own worker reads packets and writes them, encoding nothing, in a new
  file of the same kind (MP4, MOV, WebM, Matroska, and for sound M4A, MP3, FLAC, Ogg, WAV, AAC). Only
  the writer's own stamp stays. A file we cannot write says so in one line. The note says what stays:
  the sound, tones included, and whatever the picture shows.

- **Find where** (`components/FindWhere.tsx`, `components/PlaceMap.tsx`,
  `lib/client/where.ts`, `lib/client/where.worker.ts`): a spot and a start
  time out, in the browser. It asks only what is missing: the day and hour come filled in from the
  file (the page says from which tag), and roughly where is a town offered as you type (`searchPlaces`,
  our own gazetteer), coordinates, or "Use my location" (a 100 km square); with nothing missing it
  goes straight to the search. The sound
  is decoded at the analysis rate, then a worker finds the tones, fetches that day's tiles for the
  area, and runs `whereWhen`, with one bar and the time left for the whole job (`lib/core/progress.ts`),
  the best guess so far, hedged, as soon as there is one, and a way to cancel; the tones and
  "Take them out" stay usable meanwhile. "Probably here" only when a place is named and the flag is up, else "Best guess" and
  up to two more answers; the map (`SpotPlot` only as its fallback), the start in UTC and local time, each plane with its registration
  (the history keeps no callsign), type, distance and passing time, its spectrum with the curve.
  A share card (`lib/client/where-card.ts`, the same `drawCard`) holds the map as it stands on the
  screen, one curve, the place and the time; the plot takes the map's place without WebGL or tiles,
  with the spot out of view, or with another answer picked. It is drawn only on the sharer's click,
  and nothing is sent until they choose where.
  A search that catches the check before its end stops it. Once the search has answered with tones, the
  check does not run again: the page shows the search's tones, with no count since a search cuts them differently, and the check's own finder
  runs only on "Take them out", since that is what evals/leak measures. With no tone, it runs once the
  page is at rest; called off, at once. Its pictures are sketches until then.
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
  - **Sure or not**: "Probably here" only when the rule names a place ("When a place is named"
    below) and `whereWhen`'s flag is up, so the usual named result is "Best guess", and most files
    name none. Its sentence says no other answer comes close in the square and time searched: the
    flag knows nothing of what lies outside them. It leads with the spot, the
    start, the flyovers it explains and which planes, then the next distinct answers and how far
    off they are (the lead stays on the best guess while they are looked through). Every word
    stays a guess ("Would have started", "Guess" on the plot), even when it is the right spot:
    colsto's hour window found the spot within 55 m with the flag down. The one honest line,
    `where.result.honest`, quotes "When a place is named" below: update it with that measure.
  - **Terrain**: the open terrain tiles of zoom 10 in one file of our own bucket, read by ranges
    (`docs/terrain.md`), so the search uses real ground height and reaches no third party. It falls
    back to flat if a tile fails.
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
  Node on this Mac, before the line check of 2026-11-03; the hot loops of 2026-11-04 (#64) brought
  16 clips from 2.70 s to 1.68 s of CPU, about where they were before it, with every answer the
  same. Measured with `pnpm speed` (Node, CPU time, golden comparison of results) and `pnpm
  speed:browser` (real Chromium: time to the verdict, memory, first load). Since then the check and
  the search split over a small pool of workers (`lib/client/pool.ts`: the cores less one, six at
  most; #77, #81), the cleaned sound the same to the last byte. On the page,
  production build, an 18-core Mac under load: a 10 minute file's tones in 3.3 s (was 15.3 s), out
  of it in 14.5 s (was 39.8 s), colsto's real hour searched in 28 s (was 64 s). On a phone, or
  on 4 GB or less, the pool also keeps the job's estimated peak under a budget (700 MB on a phone):
  fewer workers, or none. Estimated from Chromium's numbers and tested in Chromium's emulation: no
  real iPhone has run it. The search alone is past that budget with no worker at all (989 MB for 10
  minutes over dense New York, 1479 MB for an hour), which the pool cannot fix.
- Somewhere else (2026-11-03, `evals/somewhere-else`, CI corpus: 15 made-up skies and 15 real
  Phoenix skies, voice notes of 30 to 60 s). The page's own check names the planted plane
  strongly in 0.90 of scenes, and never a plane it did not plant. With the true tracks of that
  minute instead of the page's dead reckoning: 0.83 (0.70 before the line check), and never a
  plane it did not plant. From 3 km away: 0. The planes sit 47 dB under the voice (median). At
  home, with home's own sky, one of home's planes is named strongly in 0.07 of scenes (0.37
  before the line check, 0.10 before the cap on distance): see Next #2.

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
| colsto's hour, best answer | 64 km, 24 min | 164 m, 2 s (39 km and at sea until 2026-11-04) | 55 m, 0.9 s |
| colsto's hour, CPU | under 240 s, 2 GB | 206 s, 1.5 GB | 35 s, 1.6 GB |
| Livermore pairs, within 250 m | 2 of 18 | 6 of 20 | 8 of 20 |
| Livermore pairs, truth among the answers | 3 of 18 | 6 of 20 | 9 of 20 |
| Livermore pairs, median error | 9 to 79 km when missed | 19 km | 12 km |
| Livermore pairs, CPU p50 | about 20 s a recording | 48 s | 13 s |

- An hour instead of a day: 2 more pairs of 20, for a quarter of the CPU. It is worth 3.2 nats (ln 24).
- The day still misses most pairs (14 of 20) and the hour 12 of 20. colsto's hour is found because
  3 flyovers are read well there: a Cessna 208, a Piper PA-30 and the Beech 350.
- Memory: 0.6 to 0.9 GB for a pair in Node, 1.6 GB for colsto's hour, whose stacks are held whole. A
  phone is perhaps 2 to 3 times slower and tighter on memory: not measured.
- One recording alone (40 recordings): median 37 km by day and 34 km with the hour, within 1 km 1 of 40 and 2 of 40. See below for why this cannot improve much.
- The flag: raised 0 times in 125 searches of single recordings, pairs and colsto, so never wrong,
  and down on all 19 right answers. Raised at 3 nats over the search, it was wrong on colsto's day
  (39 km off, 5.6 nats over, 3.1 ahead of the truth), so it now takes 8. It does not earn its keep yet.

Answers on the water (2026-11-04, `lib/core/sea.ts`): people rarely record from the open sea, so a
spot out on the water loses 4.6 nats against one on land (ln 100, about one recording in a hundred).
It moves down, never out: the best by the sound alone stays second at worst, and the flag's lead is
still counted by the sound alone, so this prior can never raise it.

| 100 km, day and hour | searches | best answer at sea | first and right (1 km, 30 s) | truth among the answers |
|---|---|---|---|---|
| colsto's hour | 2 | 1, now 0 | 1, now 2 | 2, now 2 |
| colsto, 16 min from +9 min | 2 | 1, now 0 | 0, now 0 | 0, now 0 |
| Livermore pairs | 40 | 1, now 0 | 14, now 14 | 15, now 15 |
| Livermore, one recording | 80 | 8, now 0 | 3, now 3 | 4, now 4 |

- No right answer lost in those 124 searches, one gained: colsto's day, from 39 km off (Long Island
  Sound, 4 km from land) to 164 m. No truth lies at sea, so the rest is wrong answers replaced by
  wrong answers on land: on the 16 minutes that gave an answer in the Atlantic on production (the
  hour known), the best is still 37 km off, though the right planes and start now reach the answers
  (fourth, 1.7 km off, 3 s). Phoenix (6 searches, inland, no spot of the square reads 0) cannot move.
- From a boat: colsto's hour with the sea brought within 3 km of the truth keeps the truth second,
  332 m off, 3 s, "at sea", behind a spot on land 39 km off. Without the rule that keeps the best
  by the sound second, 11 spots on land would rank above it.
- The penalty: any from 3.2 to 100 nats gives the same answers on these corpora. The margin: anything
  from 500 m to 3 km too. Under 250 m one more pair's hour moves up (truth third behind two spots
  250 m off a shore), left out: a point on Fire Island reads 0 with land 500 m away.
- "On the water": the terrain reads 0 at the spot and everywhere within 1 km, outside 17 boxes of
  land below sea level. Height at or below 0 alone misfires: Badwater, Jericho, Flevoland, Rotterdam,
  Brawley, Astrakhan, Turpan and the Sacramento delta all read 0, and the margin saves only the
  narrow ones (Brawley has no ground above 0 within 14 km). The boxes come from the 802 of 236,907
  GeoNames towns with no ground above 0 within 10 km on coarse tiles, and the depressions on the map.
  Water inside a box counts as land, lakes too (the terrain gives their surface: Lake Michigan 175 m).
  With no ground above 0 in the whole square the terrain says nothing (flat when its tiles fail) and
  nothing is at sea. A single failed tile still reads as water: rare, and it costs a rank.
- The page says "At sea": `nearestPlace` has no limit, and said New York City from 61 km out and
  Queens from 34 km. Within 5 km of a town it stays "Near" (`townOf`), which also covers a low patch
  the boxes miss.

When a place is named (2026-11-04):

On 112 files at 100 km with the hour known, the page named a place on 107 and 76 of those were
wrong, every one under "Best guess". Worth alone does not separate right from wrong: wrong answers
reach rank 22.9, right ones start at 6. The number of planes heard very well at the top answer does
most of it.

- The rule (`namesAPlace` in `lib/client/where.ts`): a file names a place only with three passes or
  more, and when the best answer itself holds three planes heard very well, those are a third of the
  file's passes at the least, and its rank is at or above what the search's size makes by chance. The
  third is there because a long file holds three chance fits as easily as the true ones: colsto's hour,
  31 passes, holds three at the truth (rank 19.6) and three twenty hours away from it (rank 19.3).
  `whereWhen`'s flag does not stand in for this, it is only said on top ("Probably here"): chance rises
  with the file's traces and MARGIN does not, so the flag can rise where the truth is not (lines below).
- Too few passes: the page says so before any flight is read, and offers to look anyway. An answer
  that fails the rule shows no place as the answer: "This file holds too few flyovers to place it",
  that it takes several clear flyovers and not just more minutes, and the candidates behind a link that says they are probably wrong.

| 100 km, hour known, right = 1 km and 30 s | files | right (flag) | wrong named | no place named | no tone |
|---|---|---|---|---|---|
| before | 112 | 31 (8) | 76, all "Best guess" | 0 | 5 |
| the rule | 112 | 12 (7) | 0 | 95 | 5 |
| before, day only (35 of the 41 files of three passes or more were run; under three passes a file is refused unread) | 35 | 15 (9) | 20, all "Best guess" | 0 | 0 |
| the rule, day only | 35 | 9 (8) | 0 | 26 | 0 |

| By file, hour known | files | before: right, wrong | the rule: right, wrong |
|---|---|---|---|
| one recording | 40 | 2, 36 | 0, 0 |
| two recordings | 20 | 8, 12 | 0, 0 |
| 3 recordings of one day | 12 | 6, 6 | 3, 0 |
| 4 | 6 | 5, 1 | 1, 0 |
| 6 | 4 | 4, 0 | 3, 0 |
| 9 | 3 | 3, 0 | 3, 0 |
| 11 or more | 2 | 2, 0 | 2, 0 |
| colsto, 2 min cuts | 6 | 0, 4 | 0, 0 |
| colsto, 4 min | 6 | 0, 5 | 0, 0 |
| colsto, 8 min | 6 | 0, 6 | 0, 0 |
| colsto, 16 min | 4 | 0, 4 | 0, 0 |
| colsto, 30 min | 2 | 0, 2 | 0, 0 |
| colsto, the hour | 1 | 1, 0 | 0, 0 |

Among the 95 files that no longer name a place, the best answer was wrong 76 times and right 19 times: the rule loses 19 right answers to remove 76 wrong ones. By passes in the file, before: one pass 2 right of 46, two passes 7 of 23, three or more 22 of 41. Worth does not tell them apart: wrong answers reach rank 22.9, right ones start at 6.

| Picked in this order | Seen when it was picked |
|---|---|
| 1. Three passes, three planes heard well on the best answer | The 112 files with the hour known, on an earlier main, 72 of them first. No search where the truth cannot be had run. |
| 2. A third of the passes | Those files, and 55 wrong hours of colsto's hour and its 30 minute cuts, 5 of which the first condition let through. |
| 3. The flag no longer a way through | Those, 74 wrong hours in all with one flag up (at refine 3, then the same at the page's settings), and 84 wide units with two flags up. |
| 4. Rank at or above S | Those, and 50 of the last stage's 180 searches, one of which the rules above let through: rank 15.7 against 19.6. Frozen at that point. |
| Nothing after that | The other 130 of those searches are the only test it has not seen. |

The counts of passes and planes chosen on some files, the third and the rank kept, tried on files of other recordings, 72 files without the singles:

- Chosen on Livermore, tried on colsto (25 files of a recording never seen): (2,0), 0 right, 1 wrong, 21 refused, 3 none. Livermore alone does not ask for three planes once the third and the rank are there; colsto does.
- Leave one day out: 12 right, 1 wrong, 56 refused, 3 none. (0,3) chosen 6 times of 7, and (2,0) for colsto, which is that one wrong. The fixed rule on the same files: 12, 0, 57, 3.
- Chosen on colsto, tried on Livermore: (0,3), 12 right, 0 wrong, 35 refused.
- Half the days on the other half: 16 files to 31, (0,2): 9 right, 0 wrong, 22 refused. 31 files to 16, (0,0): 6 right, 1 wrong, 9 refused. A sample this small cannot set the counts alone.

Searches where the truth cannot be (same squares, hours or days away from the recording), anything named there is wrong:

| where the truth cannot be | searches | a place named before | "Probably here" before | three planes alone | the rule | the rule with "Probably here" | after the freeze: searches, the rule |
|---|---|---|---|---|---|---|---|
| 100 km, a wrong hour (page settings) | 109 | 109 | 1 | 2 | 1 (upper 5.0 %) | 0 | 64, 1 |
| 100 km, a wrong hour (refine 3) | 78 | 78 | 1 | 7 | 0 (upper 4.7 %) | 0 | 0, 0 |
| 100 km, a wrong day (page settings) | 73 | 72 | 3 | 9 | 3 (upper 11.4 %) | 2 | 66, 3 |

The last test: the rule was frozen at 08:30:39 with 50 of the last 180 searches seen, and #94 shipped with 84 of them in. All 180 in, nothing changed after the freeze: 130 searches after it, 4 named a place: a wrong hour, four recordings, 41.3 km off, 3 planes of 4 passes, rank 17.6 against S 16.5, "Best guess"; a wrong day, six recordings, 39.5 km off, 3 planes of 6 passes, rank 28.2 against S 19.6, "Probably here"; a wrong day, nine recordings, 22.2 km off, 3 planes of 9 passes, rank 23.9 against S 19.5, "Best guess"; a wrong day, nine recordings, 30.3 km off, 4 planes of 9 passes, rank 28.9 against S 19.5, "Probably here". By file, since searches share recordings: By file: wrong hour 19 files, 1 named, 0 "Probably here"; wrong day 27 files, 2 named, 2 "Probably here". The rule only removes answers: before it, a place was named on nearly every one of these searches.

The rank here leaves out the cost of the sea, so these counts are at most. No null bound is on the page: it quotes the true files' rate only.

At the page's settings, the flag alone: six recordings, two hours after the real time, 37.1 km off, 2 planes of 6 passes, rank 25.03 against a threshold of 24.48; eleven recordings or more, a wrong day, 16.9 km off, 3 planes of 11 passes, rank 29.08 against 27.3. Both say "Probably here" on main and are refused here. Two wide searches at 333 km on a day away, same settings: nine recordings, 290.8 km off, 3 planes of 9, rank 35.17, passes this rule, one more reason it does not widen the search; eleven or more, 82.2 km off, 2 planes of 11, refused.

Limits: every file that names a place is a group of recordings read as one file. No single natural file does, and the one natural long file is refused at 60 minutes, 3 planes of 31 passes, with the truth as its first candidate. So the page says several clear flyovers help, not more minutes: six or more recordings joined named a place 8 times in 9, the real hour none. One real long file (colsto), 0 wrong of 12 has a 95 % upper bound of 24 %, and GOOD and the 15 s inside `wellHeard` were set earlier on these same recordings. The files are 41 recordings on 7 days, 25 cuts of one hour.

Measured with a throwaway harness on `main` at 36662df: groups of recordings of one site and day read
as one file with gaps, colsto's hour in cuts of 2 to 30 minutes. `evals/wherewhen-named.eval.ts` is that
measure, kept (`pnpm eval evals/wherewhen-named`). In the real page on the real bucket, colsto's hour
took 44 s at a machine load above 500: the refusal, then its first candidate on the truth, 206 m off.
On the live site after #94, 69 s at a load of about 20: the refusal, no spot shown as the answer.

How wide it can go (2026-11-04, `main` at 36662df, throwaway harness): not safely past the square asked for.

Chance grows as the log of what is searched. Over a day, 100 km is 19.7 nats, 1000 km 24.3, the US 26.4,
the land of the world 29.3, and the whole archive adds 5.7. Each clue, in nats of chance removed: hour
against day 3.2, day against week 1.9, week against month 1.5, month against the archive 2.3; 100 against
300 km 2.2, 300 against 1000 km 2.4, 1000 km against the US 2.1, the US against the world's land 2.9. A
flyover read very well gives 6 to 12. Knowing nothing costs 18.5 nats more than an hour and a square: 2 to
3 more flyovers read very well, 5 to 6 in all.

Measured on 8 files that hold many flyovers (7 groups of 6 to 18 recordings, colsto's hour): the truth's
unit of 333 km with real terrain at 12 refined, then a sample of the other units, flat at 3 refined.

| Row, day known unless said | right ("Probably here") | wrong | no place named |
|---|---|---|---|
| 1000 km | 6 (6) | 0 | 2 |
| US | 6 (6) | 0 | 2 |
| world | 6 (6) | 0 | 2 |
| 333 km, whole archive | 6 (6) | 0 | 2 |
| world, whole archive | 6 (5) | 0 | 2 |

Those rows have the truth inside, and that is what holds them up. Of 95 units searched without it, 6 name
a wrong place under the rule and 2 raise the flag. Rerun at the page's settings, one of those two still
says "Probably here", 290.8 km off, on 3 planes of 9 passes, rank 35.17: it would clear S even over the
whole archive and the whole world (35.0). The page cannot tell a right wide answer from a file made
elsewhere, so wide is not safe as it stands.

- What would make it safe, chosen on these searches and not tried on others: a margin of 16 nats instead
  of 8 (0 of 161 searches where the truth cannot be reach it, 17 of 44 right answers do), or four planes
  and half of the passes (0 of those units, 6 of 7 truth units).
- It would serve only files with many clear flyovers. Colsto's hour is 118 km off from 333 km up, on two
  planes, and minutes of real sound name nothing even at 100 km with the hour known.
- Cost per unit of 333 km over a day: the truth's 185 s of CPU (p50) and 17 MB; others 7 to 214 s and 2 to
  19 MB. Whole zones, extrapolated, not run: 1000 km about 10 CPU minutes, 43 MB of flights and about 45 MB
  of terrain; US about 1.7 CPU hours, 230 MB; world 3 to 7 CPU hours, 345 MB; each times the days searched.
- An index, not built: entries measured at 6,700 to 7,800 per MB of tiles on 2 days and 2 regions, the rest
  estimated. A known place over an unknown day: about 40 kB a day for a square, about 12 MB over the
  archive, range reads from the browser, nothing of the file sent, candidate hours for today's search. An
  unknown place: 6.4 GB raw, a server that receives the tones' shape, which conflicts with "nothing of the
  file is ever sent": the founder's decision. An index only speeds up; wide needs the stricter rule first.
- Not run, on purpose: 300 km on this base, 1000 km with every unit, 100 km over a week or a month (about 4 CPU
  hours for the 300 km and 1000 km rows). They cannot decide anything until a stricter wide rule exists, and
  that needs fresh files with many clear flyovers, which we do not have. 300 km has one older number:
  `main` at 9a0a8ea, an earlier rule, 20 files right at the hour: 8 right, 0 wrong, 12 refused. The cost of
  a week and a month at 100 km is extrapolated from the day: about 10 and 43 CPU minutes, 84 and 360 MB.
- Decided not to do now (2026-11-04), and what would reopen each:
  - "Probably here" on a day that was not confirmed: 2 wrong in 73 wrong-day searches, on 2 of 27 files, only on groups of 6 or more
    recordings, with a wrong day given by the user. No natural file raised the flag where it was searched, and the
    flag rose on such days before the rule too. Reopen when a natural file reaches "Probably here", or with
    an unknown-day search, where wrong days are the normal case. The idea then: a second pass, the same file on
    other days as its own chance level. In sample, a margin of 6 over the best other day removes the wrong
    ones and keeps 7 of the 9 right at the day; a flagged day search goes from about 86 to about 260 CPU s. Fresh
    days are written down (162 searches, about 3 CPU hours), they are fresh days, not fresh files. A plain "4
    planes" does not work: one wrong answer holds 4 of 9.
  - A stricter wide rule: margin 16, or 4 planes and half of the passes, was chosen on the only 9 files of 6
    or more recordings, cut from the same 41 recordings, so running them again proves nothing. Reopen when 10
    to 20 natural files with 6 or more clear flyovers exist (the founder's `?capture=1` recordings), with fresh
    null units, about 2 to 4 CPU hours. Even then it serves such files only, not a clip found online.
  - Two tones per flyover: a second tone that reads is common (27 of the 31 flyovers with a plane at the truth
    in the 40 single recordings, 12 with one clearly better than the lead, 5 where the lead does not read at
    all; 2 of 4 in colsto's hour). But the count of planes heard well at an answer already reads every trace,
    so a second tone can raise the rank, never that count. From the readings already recorded at the truth of
    the 112 files with the hour known, the rule could pass at most 15 (overlapping traces are one flyover) to 23
    (every well-read trace is a plane) of them, against the 12 named today, all stitched groups: 0 of the 40
    recordings, 0 of colsto's 25 files. So it cannot make a real clip name a place. Not built, not run (the 3
    CPU hours, and 20 minutes on the files in that gap). Reopen if the rule's count of planes changes.

Why it does not find more yet (measured):

- Physics: over a day at 100 km the search is 19.7 nats (spots and starts at 500 m and 10 s), an
  hour 16.5, and one flyover read very well gives 6 to 12. One flyover cannot be told from chance,
  two are about even over a day.
- The data: in 8 of the Livermore recordings the lead tone cannot read at the truth for want of
  points: the flight has a gap over 60 s in the index around the pass (R08, R24), no points near it
  (R13, R17, R50), points only from 17 s on (R44), or its closest moment outside the clip (R57, R59).
- The lead tone: one tone per flyover, the most confident. On R03 it jumps a harmonic (211 to 102
  Hz), on R02 it runs past the flight's data, while a weaker tone of the same flyover reads 0.17 and
  0.33 at the truth. Two tones per flyover cannot make a real file name a place: see "How wide it can go".
- A lucky fit can lead, as on R40 + R23 over a day. Capping a fit's worth at a loss of 0.1 finds
  that pair and misses another (still 6 of 20) but loses colsto's hour (truth second, 250 m).
  Scanning only the distances a tone's steepest slope allows saves 10 to 25 % of the CPU and, with
  the cap on, drops colsto's truth to 11th. Both left out.

What the web version needs:

- The history (above): a daily job and a bucket, about 0.13 $ after a month.
- The search in a Web Worker (`lib/core` runs as is, `onProgress` reports the stage): about 7 MB
  of history tiles and about 1 MB of terrain tiles for a 100 km square (Terrarium PNGs, zoom 10, in
  our own bucket beside the history: `docs/terrain.md`).
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

## A cap on distance (2026-11-04)

Is "strong" safe to cap by the plane's closest range in the recording? Past `STRONG.range`, 10 km, a
plane that clears the score and the lead now reads "possible": one comparison in `verdictOf`
(`lib/core/match.ts`), which `analyze()` calls. Each eval's report has its calibration line.

| planes named strongly | n | closest m, p50 / p90 / max | height m at closest, p50 / p90 / max |
|---|---|---|---|
| real audio, right (Livermore, AeroSonicDB) | 38 | 1658 / 3934 / 5680 | 1347 / 2859 / 5831 |
| real tracks, right | 16 | 1202 / 2314 / 2468 | 762 / 1143 / 1372 |
| colsto's hour, no truth | 9 | 8181 / 13401 / 13407 | 632 / 937 / 1059 |
| wrong: the E2E's jet, 3 of 50 cuts | 3 | 14424 | 9449 |
| wrong: home's phoenix-6-22 | 1 | 11071 | 11102 |
| wrong: home's synthetic-3 | 1 | 5549 | 5578 |
| wrong: home's phoenix-9-25 | 1 | 2923 | 1280 |

| cap | right lost: real audio (38), real tracks (16), synthetic and somewhere else (66) | colsto held back, of 9, no truth | the jet's strongs left, of 3 | home's strongs left, of 3 |
|---|---|---|---|---|
| 6 km | 0, 0, 0 | 5 | 0 | 2 |
| 8 km | 0, 0, 0 | 5 | 0 | 2 |
| **10 km** | 0, 0, 0 | 3 | 0 | 2 |
| 12 km | 0, 0, 0 | 3 | 0 | 3 |

- The zeros say little past 6 km: no labelled plane is farther than 5680 m, strong or not (51
  recordings with the plane in the data), since these corpora are flybys picked close by. They do
  not measure how often a far plane named strongly is right.
- Only colsto speaks past that, with no truth. Its Cessna 208 and PA-30, 8.2 to 8.4 km away, are
  flyovers the where-and-when search also reads, so the cap sits above them: 6 or 8 km would hold
  them back and take nothing more from home or the jet. 12 km keeps phoenix-6-22. At 10 km, if the
  three jets held back (F900, E170, CRJ9, 12.3 to 13.4 km) were all right, the cost is 3 of the 47
  strongs on real audio (6 %) reading "Probably". Their pitch moves 23 to 62 %, as much as a right
  plane's, so nothing says they are wrong either.
- A jet cruising at 33,000 ft is over 10 km away even straight overhead: it can no longer read "It
  was", whatever its score.
- Height separates less: right planes reach 5831 m, the jet flies at 9449 m and phoenix-6-22 at
  11102 m, a gap of 1.6 times against 1.9 for range. A cap on height between them would take those
  two out too and hold nobody back on colsto, whose far jets are 600 to 900 m up, so it would leave
  those three strong. A wrong name costs more than a missed "for sure": range it is.
- From 3 km aside (somewhere else), the planes other than the primary named strongly sit at 1.9, 8.1
  and 13.6 km; the last now reads "possible". Not judged here: the ratchet counts the primary only.

## Does the sound agree with a stated place and time? (2026-11-04)

Not built, measured only, by a throwaway harness outside the repo. The question: a file states a place and a time (its own GPS and clock, which `lib/client/metadata.ts` already reads), and the sound either agrees or cannot say. Rules and readings were fixed before half B ran; intervals resample files. Half A is 32 files, half B 30 (2 have no tones). False claims moved the place 5 to 1000 km or the time an hour to a week.

| Reading | Half A | Half B |
|---|---|---|
| 1 km and 10 min, rank at or above chance (6.87) + 2, one plane heard well: true | 4 of 32 | 7 of 30, 23 % (10 to 40) |
| same: false | 6 of 704 | 12 of 660, 1.8 % (0.8 to 3.2) |
| 500 m and 60 s in its own square, chance 3.87, rank at or above 5.87: true | 10 of 32 | 11 of 30, 37 % (20 to 53) |
| same: false | 1 of 704 | 3 of 660, 0.45 % (0 to 1.06) |

- It separates, and the place of the reading separates better than its score. At 1 km and 10 min a pass multiplies the odds by about 13; on colsto's cuts alone it does not show.
- The independent proof is small: colsto's 5 tight true passes are nested cuts of 2 flyovers. Livermore's position and clock were fitted from flights, so its true claims start in-sample.
- An ordinary sky is the hard case: 0 of 12 on the 2 and 4 minute cuts.
- "No plane fits" refutes nothing: it is 41 to 43 % of true claims.
- At the tight size a time moved by an hour or more never passed (0 of 372); a place moved passed 4 of 992. Moves under 5 km or under an hour were not run. Busy skies were not measured.
- It could never say "filmed there" (anyone within a few km hears that plane, and a soundtrack can be laid over other pictures), that a claim is false, or anything about a caption: a town and a day has chance 15 to 17 nats against 6 to 12 for one flyover. Platforms usually strip the tags, so an online clip rarely has a claim this tight.
- A square that small cannot beat its own chance: the table has to come from the 100 km hour around the claim. Cost on a page: 3 to 4 CPU s for a recording, 14 to 18 for 30 minutes, about 10 to 20 MB.

Waits for 10 to 20 phone recordings through `?capture=1`, with GPS and a clock in the file. Suggested gate, on those files: at least 20 % true passes and at most 1 false pass in 200.

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
   tell these apart, and the level does not either (section "The level of a tone"). phoenix-6-22,
   11 km away, went with the cap on distance of 2026-11-04 (section of that name): 2 of 30 now.
   STRONG stays at 9. `analyze()` returns `unexplained`, the lines no aircraft
   of the data explains, and `ghosts`, those a visitor can be told (`GHOST` in
   `lib/core/explain.ts`, measured by `evals/ghost.eval.ts`): the flyby follows 80 % of it,
   confidence 20, no aircraft of the data follows half of it at any tone, read as a straight pass
   it is 300 m away or more. Told on 1 of 276 recordings with nothing to find (0 of 90 voice notes,
   1 of 107 stretches of street sound a human labelled free of aircraft, and that one looks like a
   far plane), 3 of 190 on the same street cut to 60 s; never with the heard plane in the data
   (0 of 191); 23 of 38 real planes left out of the data, always the right line, read within a
   factor of 2 in speed 28 times in 28 and in distance 25 in 28. Left: a line the data's other
   planes could follow at some tone is not told, so a busy sky hides it; and in the E2E's made-up
   sky, the heard plane left out, a jet at 31,000 ft reached a strong score (9.2 to 9.5 on 3 of 50
   cuts, 9.9 on one noted before), with no line found and 6.8 to 9 s of its curve known, since its
   sound takes 45 s to arrive. 14.4 km away, it now reads "possible" under the cap on distance.
3. Wind: Open-Meteo wind at 10 m and aloft into `Air.wind` (the synthetic eval shows wind costs
   about one score point at 8 m/s).
4. Two aircraft heard at once (two helicopters at Adelaide, a jet and a Cessna in Livermore
   R21): say both when both curves stand out and do not overlap, instead of "none" for want of
   a lead.
5. Speed: what is left in `analyze()` is tight loops, each under 10 % (stopped there, #64); `locate`
   and the join stay on one thread, whose stacks and flights would have to be copied. Next, if a
   phone takes more than a few seconds: coarse-to-fine tone search, or lines only near the
   candidates' tones. Both would change results, so they need a measured table.
6. adsb.lol rate limit (about one request every 2 s per address): listeners of a 0.25° square
   share one upstream poll, at most one every 2 s, but the limit is per address and every active
   square adds its own requests (Vercel Hobby allows a single rate-limit rule, spent on
   `/api/donate`): ask adsb.lol for a key.
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
9. Where and when: guesses come from the real tracks. A place is named only on three passes and
   three planes heard very well, a third of the passes at the least, at a rank chance does not make:
   12 files of 112 with the hour known, no wrong place named on that set. Next: a flag that can be raised (section "Where and when: the search"). Widening: not safe yet, see "How wide it can go", which also lists what we chose not to build and what would reopen each.

10. "Strong must never be wrong", what is left after the level and the cap on distance:
   - At home with home's sky, 2 of 30 stay strong (synthetic-3 at 5.5 km, phoenix-9-25 at 2.9 km),
     inside any cap that keeps the right planes. Nothing found in the sound tells them apart.
   - colsto's hour read in cuts of 2.5 minutes (`evals/level.eval.ts`): 6 strong in 30 now. Three are
     flyovers the where-and-when search also reads (Cessna 208, PA-30, Beech 350), two an R44 4 km off,
     and one an A220 at 49 Hz, 3 km off: no truth for it. No eval has a truth here yet.
   - `STRONG.range` has no labelled plane past 5.7 km behind it. A far flyby recorded with its truth
     (item 1) is what would check 10 km.
   - `result.score` in `messages/` no longer says no score reaches {strong} with no plane to find,
     as an absolute: home's two scored 11.9 and 10.6, the E2E's jet 9.9. On the 66 recordings with
     nothing to find, the top score is 7.88: 15 made-up scenes have no plane in the sound, the other
     51 (36 real) have the heard plane left out of the data, so these numbers say little about silence.
   - A floor of 15 s of known curve stays open: it would have taken out the jet too, with nothing lost
     on 119 strong and right planes (shortest 23.5 s), mostly with polls from well before the recording.

## Needs the founder

- Commercial or not? AeroSonicDB (CC BY-NC), ADS-B Exchange samples and OpenSky restrict
  commercial use; adsb.lol (ODbL) and the Livermore recordings (CC BY 4.0) do not. The evals use the restricted sets only locally.
- Request access to AeroSonicDB 3K (3,058 events): an email to its author with the project.
- Donations license: CC BY 4.0 for the sound, but the anonymised tracks come from adsb.lol
  (ODbL). Confirm the combination before the first release of the dataset.
- If it ever becomes commercial: adsbdb.com (names, routes) and planespotters.net (photos, credit
  and link required) are free services with their own terms; check them first.
