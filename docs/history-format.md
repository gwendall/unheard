# Flight history format, v1

The past of the sky, as Unheard reads it to say where and when a recording was made: for each UTC
day, every aircraft that flew low enough to be heard, cut into tiles a browser fetches one by one
over plain HTTP. Static files only: no database, no server code. Built by
`pnpm history:build <day>` (`scripts/history-index.ts`), read by `lib/history.ts`.

## Licence

The history is a derived database of adsb.lol's `globe_history` releases
(https://github.com/adsblol), published under the **Open Database License 1.0** (ODbL), like its
source. Attribution: **"© adsb.lol contributors"**. Anyone may host, mirror or rebuild it under the
same licence; share-alike applies to databases derived from it. Aircraft kinds come from the ICAO
type table of tar1090-db (https://github.com/wiedehopf/tar1090-db) at the commit in the manifest.

## Layout

```
<base>/days.json                       the days built, on a hosted copy
<base>/<YYYY-MM-DD>/manifest.json      what a reader needs: tiles, counts, sizes, hashes
<base>/<YYYY-MM-DD>/<lat0>_<lon0>.bin.gz   one tile
<base>/<YYYY-MM-DD>/build.json         how long that build took (not needed to read)
```

`<base>` is one setting: our bucket ("Hosting" below), a folder served in development, or anyone's
mirror. The core code never names a URL: it takes a fetcher (`Fetcher` in `lib/history.ts`: a path
under the base in, bytes or null out), `httpFetcher(base)` for HTTP.

A tile is 1° by 1°, named by its south-west corner (`37_-122` covers 37 to 38° N, 122 to 121° W).
A tile whose file would pass 5 MB is cut in four tiles of half the side, again if need be
(`40.5_-75` is the north-west quarter of `40_-75`): read the tiles' corners and sides from the
manifest, never from the names.

## What is kept

From each `trace_full_<icao>.json` of the day (readsb's trace format): every airborne point (not
`"ground"`) with a position, a ground speed and a track, at or below 10,000 ft pressure altitude
(geometric altitude when no pressure altitude was received). That keeps every propeller and rotor
aircraft near the ground, and jets on approach and departure, flagged as such.

## manifest.json

```json
{
  "format": "unheard-history/v1",
  "build": 1,
  "day": "2026-05-16",
  "source": { "repository": "adsblol/globe_history_2026", "release": "v2026.05.16-planes-readsb-prod-0",
              "assets": [{ "name": "...tar.aa", "size": 2000000000 }, ...],
              "licence": "ODbL-1.0", "attribution": "© adsb.lol contributors" },
  "types": { "source": "https://github.com/wiedehopf/tar1090-db", "commit": "2ab834a..." },
  "filter": "airborne, at or below 10000 ft pressure altitude ...",
  "tiles": { "37_-122": { "lat0": 37, "lon0": -122, "size": 1, "runs": 1234, "points": 151000,
                          "bytes": 1966175, "sha256": "<file>", "content": "<decompressed>" }, ... },
  "totals": { "tiles": 2551, "aircraft": 55437, "points": 42891497, "bytes": 267270573 }
}
```

`sha256` is the hash of the `.bin.gz` file as served; `content` the hash of its decompressed bytes.

## Determinism

The same release, the same `build` and the same tar1090-db commit give byte-identical tile
contents: runs are written sorted by address then start, whatever order the workers finish in, and
every value is rounded the same way. The gzip stream has a fixed header (no time, no OS byte) and
level 6; it is byte-identical with the same zlib (Node's bundled one, per Node major). To check a
hosted copy, rebuild the day and compare `content` (always) or `sha256` (same Node).

## A tile (`.bin.gz`, gzip of the bytes below, little-endian)

Header, 40 bytes:

| offset | type | field |
|---|---|---|
| 0 | u32 | magic `0x31484855` ("UHH1") |
| 4 | u32 | format version, 1 |
| 8 | u32 | the day's 00:00 UTC, Unix seconds |
| 12 | i32 | south edge, microdegrees |
| 16 | i32 | west edge, microdegrees |
| 20 | u32 | side, microdegrees (1,000,000 for 1°) |
| 24 | u32 | E, runs |
| 28 | u32 | P, points |
| 32 | 8 bytes | zero |

Runs, E entries of 32 bytes: one aircraft's consecutive points inside this tile (an aircraft that
leaves and comes back has several; a run also ends at a gap of more than 6,553.5 s).

| offset | type | field |
|---|---|---|
| 0 | u32 | ICAO address (24 bits); bit 24 set for a non-ICAO address (`~` in readsb) |
| 4 | u32 | index of the run's first point |
| 8 | u32 | points in the run |
| 12 | u32 | time of the first point, tenths of a second after the day's 00:00 |
| 16 | u8 | kind: 0 unknown, 1 piston, 2 turboprop, 3 rotor (helicopter, gyrocopter, tiltrotor), 4 jet, 5 other (glider, electric...) |
| 17 | 3 bytes | zero |
| 20 | 4 ASCII | ICAO type designator (C172), zero-padded |
| 24 | 8 ASCII | registration, zero-padded |

Columns, after the runs, P values each, the runs' points one after the other in time order:

| column | unit | value stored |
|---|---|---|
| time | 0.1 s | change from the run's previous point (the first point: 0) |
| latitude | side / 65535 (1.7 m on a 1° tile) | position above the south edge |
| longitude | side / 65535 | position east of the west edge |
| altitude | ft, signed | geometric when broadcast, else pressure altitude |
| ground speed | 0.1 kt | |
| track | 0.01° true | 0 to 35999 |
| vertical rate | ft/min, signed | geometric rate when broadcast, else barometric |
| flags | bits | bit 0: the altitude is pressure altitude; bit 1: multilateration or TIS-B position |

The seven first columns are 16 bits each, stored as the change from the run's previous point
modulo 65536 (the first point of a run: its value itself), all their low bytes then all their high
bytes; the flags are one byte each. Columns of small changes, not records, so gzip packs a point
in about 6 bytes.

## Hosting

Our copy is at **https://unheard-history.t3.tigrisbucket.io/** (the `<base>` above; the same files
at `.t3.tigrisfiles.io` and `.t3.tigrisblob.io`), a public Tigris bucket (`unheard-history`): no key,
any origin (CORS: GET and HEAD). `days.json` at the top lists the days built; everything else
follows the layout above and never changes once written (`Cache-Control: public, max-age=31536000,
immutable`; `days.json`: 5 minutes). The bucket cannot be listed: read `days.json`, then each day's
manifest. The licence is the one above: ODbL 1.0, "© adsb.lol contributors".

`scripts/history-job.ts` fills it, from a scheduled Fly Machine of the app `unheard-history`
(`--schedule daily`, shared-cpu-4x, 4 GB, stops when done): yesterday's day if adsb.lol has published
it, then older missing days going backwards to 2026-01-01, within a time budget (20 minutes by
default, 40 on this Machine) and at most 3 days a run (`HISTORY_JOB_MAX_DAYS`: every day uploaded
costs about 0.02 USD, so this is what keeps the backfill under 5 USD a month). Tiles go first and the manifest last, so a day with a
manifest is complete; a failed day leaves none and is tried again next run. To change the job, build
the image and point the Machine at it:

```
fly deploy --build-only --push --config scripts/history-job.fly.toml -a unheard-history \
  --dockerfile scripts/history-job.Dockerfile --ignorefile scripts/history-job.dockerignore --image-label history-job-N .
fly machine update <id> -a unheard-history --image registry.fly.io/unheard-history:history-job-N
```

To mirror it, copy the files over plain HTTP, or run the same job against your own S3 bucket
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `BUCKET_NAME`;
the header of the script lists the settings). To rebuild one day, `pnpm history:build <day>` and
compare `content` with the manifest ("Determinism" above). A reader takes any of them as its base:
`httpFetcher(base)`, or `pnpm where <audio> --day <day> --near <lat,lon> --history <base>`.

## Versions

`v1` (2026-11-03): this document. A reader checks the header's version and refuses others. A
change in what is kept or how (the filter, the type table, the encoding) bumps `build` when the
bytes change for the same release, and the format version when a v1 reader could misread them.
