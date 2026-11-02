# Unheard

There's a plane you can't hear. Hold your phone up for two minutes: Unheard finds the faint,
pitch-bending hum of an aircraft in the recording and tells you which one it was, by matching
its Doppler curve against live ADS-B flight data.

Made by Gwendall.

## How it works

1. **Listen.** The page records raw audio (no echo cancellation, no noise suppression) and polls
   the aircraft around a coarse version of your location every 2 s (`/api/aircraft`, adsb.lol).
2. **Model.** For every aircraft, `lib/core` rebuilds its track (Kalman/RTS smoothing of the
   ADS-B fixes), then computes the exact pitch curve you should have heard: emission time solved
   for each moment (the sound left the aircraft seconds earlier), radial speed at that moment,
   speed of sound from the temperature, wind if known.
3. **Match.** The recording becomes an evidence map at four window lengths (2 s to 0.25 s; each
   point of a curve is read where its slope is best resolved). Each aircraft's curve is swept over
   its unknown tone (40 Hz to 2 kHz) and the phone's clock error (±2 s), scored against its own
   wrong guesses, and the best aircraft wins if it stands clear of the others.

Everything runs in the browser: the recording never leaves the phone. One function,
`analyze()` in `lib/core/pipeline.ts`, is the whole analysis for the page, the tests and the evals.

## Run

```sh
pnpm install
URL=$(machine serve -- pnpm exec next dev -p {port})   # never a raw next dev on this Mac
open "$URL"            # ?capture=1 adds a "Download recording bundle" button after a result
machine serve --stop -- pnpm exec next dev -p {port}
```

## Tests and evals

| Layer | What | Command | Where it runs |
|---|---|---|---|
| Unit | FFT, Doppler physics, tracks, matcher on synthetic scenes | `pnpm test` | CI |
| Synthetic eval | 66+ made-up scenes: faint, far, windy, crowded sky, plane missing from the data | `pnpm eval evals/synthetic` | CI (ratchet) |
| Real tracks | real ADS-B recorded with `pnpm record-sky`, made-up sound, half the polls | `pnpm eval evals/real-tracks` | CI (ratchet) |
| Real audio | AeroSonicDB recordings + ADS-B Exchange history, and the page's own capture bundles | `node scripts/fetch-aerosonic.ts && pnpm eval evals/real-audio` | on demand (licensed data, not in git) |
| E2E | the real page in Chromium, fake microphone playing a fixture, replayed ADS-B | `BASE_URL=$URL pnpm e2e` | on demand |

See `evals/README.md` for the metrics, the baseline and how to add real recordings.
