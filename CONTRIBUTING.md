# Contributing to Unheard

Thank you for helping. Every contribution here is judged the same way: by what it does to the
numbers in the [scoreboard](README.md#scoreboard). This page tells you how to run them, the few
rules that keep them honest, and four ways to help, from no code at all to hardware.

## Run it in 2 minutes

```sh
pnpm install
pnpm test                              # unit tests, under a minute
SEEDS=10 pnpm eval evals/synthetic     # a small synthetic eval, about a minute
pnpm dev                               # the page, on the printed URL
```

Node 22 and pnpm 10. The full evals (`pnpm eval evals/synthetic evals/real-tracks`) run in CI on
every pull request and post their numbers next to the ones on `main`.

## The rules

- **One analysis path.** `analyze()` in `lib/core/pipeline.ts` is what the page, the tests and
  the evals run. Never write a second pipeline for a test or an eval.
- **"Strong" must never be wrong.** When the page says "It was X", X is right. A change that
  makes one strong answer wrong, or one strong answer out of nothing, is not merged, whatever
  else it improves.
- **Thresholds move only with evidence.** `STRONG` and `POSSIBLE` in `lib/core/match.ts` change
  only with the calibration lines of an eval report quoted in the commit.
- **The baseline is a ratchet.** `evals/baseline.json` holds the current numbers minus a small
  margin; CI fails when a metric falls below it. When your change lifts a metric, raise it.
- **No restricted data in git.** AeroSonicDB (CC BY-NC) and ADS-B Exchange samples are fetched
  into `evals/.cache/` by a script and never committed. adsb.lol data (ODbL) may be.
- `lib/core/` has no DOM and no React: it runs in the browser, in Node and in the evals.

## Four ways to help

### 1. Record and donate a flyby (no code)

The benchmark has no phone recording yet, and phones are what Unheard is for.

1. Go somewhere aircraft pass low: near a small airfield, a heliport, under an approach path.
2. Open the page, tap "Listen to the sky" when you hear or see one coming, keep the phone still
   and pointed up for the whole pass, ideally two minutes.
3. After the result, use the donate button and tell us what you saw: which aircraft, or that you
   are not sure. The recording is anonymised on your phone before it is sent (see
   [What it is not](README.md#what-it-is-not)).

Recordings where nothing was found are as useful as the others: they are how we learn why.

### 2. Data: a city's sky, an aircraft's sound

- **A city's sky.** `pnpm record-sky <name> <lat> <lon> [minutes] [radiusNm] [every]` records
  real ADS-B tracks from adsb.lol into `evals/fixtures/sky/`; the real-tracks eval then runs on
  them. Busy places with mixed traffic (helicopters, light aircraft, airliners) help most. Only
  one recorder at a time: adsb.lol allows about one request every 2 s per address.
- **An aircraft's sound.** The matcher sweeps every tone from 40 Hz to 2 kHz because it does not
  know what each aircraft type sounds like. Each type's fundamental (rotor or propeller blade
  pass, jet fan) narrows that search. Seen so far: Bell 412 about 169 Hz, Airbus EC135 about
  131 Hz, Boeing 737 fan 0.9 to 1.9 kHz. A profile with its source (a recording, a paper, a
  manufacturer figure) is a welcome pull request.

### 3. Algorithm: beat the benchmark

Make the matcher find more, faster, without ever being wrong when it is sure. Starting points
are the "Next" list in [docs/STATUS.md](docs/STATUS.md), for example: a silent aircraft that
borrows part of a loud line, wind from a forecast, two aircraft heard at once, speed on a phone.

A good pull request shows:

- what it changes and why, in a few lines;
- the eval delta CI posts on the pull request (synthetic and real-tracks), and the real-audio
  numbers if you have the cache (`node scripts/fetch-aerosonic.ts`);
- zero "strong but wrong" and zero "false strong" everywhere;
- the baseline raised if a metric went up.

### 4. Hardware: the listening station (planned)

Many ADS-B hobbyists already run a Raspberry Pi receiver on a roof. Add a USB microphone and
the station knows its exact position, sees every aircraft that passes and can cut and label the
passes itself, day and night, with no human labelling. The design notes are in
[docs/OPEN-SOURCE.md](docs/OPEN-SOURCE.md#the-listening-station). It is not built yet: if you
have the hardware and want to prototype it, open an issue first.

## Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
