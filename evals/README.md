# Evals

Every eval feeds scenarios through `analyze()` from `lib/core/pipeline.ts`, the exact code the
page runs, and scores the verdict. Reports land in `evals/reports/<name>.md` (not committed);
`evals/baseline.json` is a ratchet: an eval fails when a metric falls below it. It holds the
default corpus (what CI runs) minus one scenario of margin; raise it when a change lifts a metric.
The real-audio corpus is whatever is in the cache: `real-audio` holds a floor that either set
meets alone, and `real-audio-livermore` holds the Livermore set's own line when it is there.

`evals/results.json` (committed) holds each eval's counts on its default corpus: a run with
`SEEDS` or `PER_FILE` set does not write it. `pnpm scoreboard` turns it into the README's
scoreboard (counts with Wilson 95 % intervals), and CI checks the README is current. On a pull
request, CI posts this run's counts next to the base branch's (`scripts/eval-delta.ts`).

## Metrics

- **heard**: an aircraft is in the sound and in the data. *strong and right* (the page says "It
  was X" and X is right), *any and right* (strong or possible), *strong but wrong* (must stay 0).
- **nothing to find**: no aircraft in the sound, or the one heard is missing from the data.
  *false strong* must stay 0.
- **oracle**: how findable the sound was with a perfect model (true track, air and tone). It
  separates "too faint to find" from "the pipeline missed it". Read the table by oracle bucket.
- **calibration**: best score and lead over the second, by outcome, and the closest range of those
  that clear both (`STRONG.range`). `STRONG` and `POSSIBLE` in `lib/core/match.ts` come from these
  lines.

## Locate me

- `trace` (`evals/trace.eval.ts`): blind traces (`lib/core/trace.ts`), the aircraft tones found
  in the sound alone, on the synthetic corpus and the real clips: how often the heard aircraft's
  tone is traced, by findability, and how often a recording with no aircraft yields a trace.
- `locate` (`evals/locate.eval.ts`): where the phone was (`lib/core/locate.ts`), searched over
  the 20 km square around the 0.1° cell the server sees, on synthetic flybys (one aircraft, the
  same with the phone's clock exact, two aircraft) and the 10 real flybys: distance from the
  best spot to the truth (median, p90, within 100 m, 250 m, 1 km), how often the truth is the
  mirror spot, by findability and by score, and the run time.

- `wherewhen` (`evals/wherewhen.eval.ts`): where and when (`lib/core/wherewhen.ts`), with no
  clue but the UTC day or hour (`WINDOWS=day,hour`) and a square to search (100 km, then 300 km,
  `SIDES=`), against that day of the flight history (`pnpm history:build <day>`). The Livermore
  recordings one by one, pairs of them made at the same site under 30 minutes apart (two
  flyovers, `ONLY=pairs`), and colsto's hour at Oyster Bay (`ONLY=colsto`, audio fetched by hand
  into `evals/.cache/colsto/`; with 16 minutes of it, and the hour with the sea brought around the
  truth, which must stay first or second): distance and start error, how often the truth is among the
  answers, how often the confidence flag is right, and the CPU time of a search. Each part writes
  `evals/reports/wherewhen-<part>-<km>-<windows>.md`, so the parts can run at once. Slow (minutes
  per recording); never in CI. The where page's numbers (`where.result.honest`, `fewText`, `wrongText`
  and `proof.whereValue` in `messages/*.json`) come from "When a place is named" in `docs/STATUS.md`,
  a wider set of files than this eval reads: update them with that measure.

## Check a video

- `leak` (`evals/leak.eval.ts`): the check page's path (`lib/core/stream.ts`, `lib/core/leak.ts`)
  with no flight data, on the synthetic corpus and the real clips: the sound read into a store at
  the analysis rate, tones found chunk by chunk, taken out along their curves and looked for again
  on that store, then every curve out of the sound at its own rate, block by block, and that sound
  searched again. Then `analyze()` with the flight data,
  before and after: a recording whose tones were found and taken out must name nobody, strong or
  possible. Also counts what "no aircraft tone found" misses (named from the flight data, no tone).
  One test and one report per corpus (`evals/reports/leak-synthetic.md`, `leak-aerosonic.md`,
  `leak-livermore.md`): `pnpm eval evals/leak -t livermore` runs one.

## Ghost planes

- `ghost` (`evals/ghost.eval.ts`): how far `analyze().ghosts` can be believed, the lines no aircraft
  of the data explains that pass the bar (`GHOST` in `lib/core/explain.ts`), which the result page
  tells a visitor. On recordings with nothing to find (made-up scenes, real tracks over a scene
  with no aircraft, voice notes of `somewhere-else` with no plane planted, stretches of real street
  sound a human labelled free of aircraft): how often something is told. With the heard plane in
  the data: how often anything is told, and its own line. With that plane left out: how often the
  line told is its line. Also how well a told flyby reads the real pass. Its ratchet is `ghost` in
  `evals/baseline.json` (made-up sound, in CI when `lib/core`, `lib/adsb.ts` or the eval changed)
  and `ghost-real` (real sound, when the cache has it).
  `ONLY=synthetic,tracks,voice,ambient,real`, `SEEDS=n`, `VOICES=n`, `TAG=name`, `RESUME=1`.
  `ONLY=ambient60` cuts the street sound into 60 s recordings instead of 120 s.

## The level of a tone

- `level` (`evals/level.eval.ts`): whether the shape of a tone's level over time tells the plane
  that made it from a plane whose curve merely follows it. It reads the level along the line a match
  rides on, against -20 log10(range) and the air's absorption for the plane's own range, a far
  plane's and the line's own flyby. Right planes (real audio) set the margins, on whole recordings
  and on cuts of 60, 45 and 30 s; then how much of a far plane on those same lines, and which wrong
  planes (the heard plane left out, the E2E's jet, home's sky), each veto would catch. colsto's hour
  has its strongs listed, never used for a margin. It did not separate (`docs/STATUS.md`, "The level of
  a tone"): measure only, no verdict reads it, never in CI. `ONLY=real,colsto,jet,home`.

## Corpora

- `synthetic` (`evals/lib/synthetic.ts`): made-up flybys, exact truth, clock error, wind and
  forecast air the model does not know, noisy and late ADS-B, hum, passing cars, bursts.
  `SEEDS=n` widens it.
- `real-tracks` (`evals/lib/tracks.ts`): tracks recorded from adsb.lol with
  `pnpm record-sky <name> <lat> <lon> [minutes] [radiusNm] [every]` into `evals/fixtures/sky/`
  (adsb.lol data, ODbL). Sound is synthesised from the track over every poll; the page gets
  every other poll. adsb.lol answers 429 past about one request every 2 s: one recorder at a time.
- `real-audio` (`evals/lib/real.ts`):
  - AeroSonicDB 1.1.2 (CC BY-NC 4.0) clips of 2023-03-01 at Adelaide with ADS-B Exchange
    snapshots (evaluation only, no redistribution): `node scripts/fetch-aerosonic.ts` fills
    `evals/.cache/` (not committed). Each clip also runs with its aircraft removed from the
    data. Sources and traps: `evals/DATASETS.md`.
  - Livermore (Pathak 2026, CC BY 4.0): 40 phone recordings of aircraft over Livermore,
    California, with each aircraft's ADS-B track: `node scripts/fetch-livermore.ts` fills
    `evals/.cache/livermore/` (not committed). Every other passage's aircraft in the air nearby
    is in a recording's data, and each runs again without its own aircraft. The microphone
    position and the start time are recovered from the published data (`evals/lib/livermore.ts`).
  - AeroSonicDB environmental recordings (CC BY-NC 4.0, evaluation only): six hours of real street
    sound in Adelaide, a human's label every 5 s. `node scripts/fetch-aerosonic.ts --env` fills
    `evals/.cache/aerosonic-env/` (not committed). `evals/lib/ambient.ts` cuts the stretches with
    no aircraft (nothing to find) and the ones around an aircraft (a plane with no flight data
    at all). Only the `ghost` eval reads them.
  - Capture bundles: open the page with `?capture=1`, record, download the bundle, add
    `"truth": { "heard": "<hex or null>", "note": "how we know" }` and drop it in
    `evals/fixtures/real/`. These are the production-condition recordings: real phone, real
    browser, real polls.
  - Donations: the result page's "Give this recording" form anonymises a recording on the phone
    (`lib/anonymize.ts`: listener at 0° 0°, scene turned at random, clock at 2000-01-01, no
    aircraft ids) and uploads it to a private Vercel Blob store. `pnpm fetch-donations` (needs
    `vercel env pull .env.local`) pulls them into `evals/.cache/donations/`, checks each with
    `lib/donation.ts`, and the real-audio eval replays those with a truth. They stay private
    until a review cuts out voices.
- `somewhere-else` (`evals/lib/elsewhere.ts`): the "Somewhere else" page (`lib/client/elsewhere.ts`)
  read back. A voice note made at home gets the sky of another place (made-up flights over a
  city, and real adsb.lol polls from `evals/fixtures/sky/`: three polls 3 s apart, as the page
  makes them), at the faintest level the page's own check names strongly. Then `analyze()` four
  ways: at the fake spot with the page's flight data, at the fake spot with the true tracks of
  that minute (what someone with the full ADS-B history would use), 3 km from the fake spot (the
  curves point to a spot, not to a city), and at home with home's own sky. It does not write
  `evals/results.json` (the home page's scoreboard): its ratchet is the `somewhere-else` entry of
  `evals/baseline.json`. `SEEDS=n` scenes of each sky (default 15).
