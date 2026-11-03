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
- **calibration**: best score and lead over the second, by outcome. `STRONG` and `POSSIBLE` in
  `lib/core/match.ts` come from these lines.

## Locate me

- `trace` (`evals/trace.eval.ts`): blind traces (`lib/core/trace.ts`), the aircraft tones found
  in the sound alone, on the synthetic corpus and the real clips: how often the heard aircraft's
  tone is traced, by findability, and how often a recording with no aircraft yields a trace.

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
