# The gazetteer

Place names with no third party: static files in the public bucket, next to the flight archive, so
that naming a spot or typing a town sends nothing to anyone but our own bucket. Built from GeoNames'
`cities500` (CC BY 4.0, "GeoNames, geonames.org"), the places of 500 people or more, by
`pnpm places:build` (`scripts/places-build.ts`), read by `lib/places.ts` and `lib/client/places.ts`:

- `nearestPlace(lat, lon, { locale })`: `{ name, region, country, countryCode, lat, lon, zone, distance }`, or null.
- `searchPlaces(query, { locale, limit })`: the same without `distance`, plus `matched` when another
  name than the usual one was typed; 5 by default. Exact names first, then the largest.
- `placeLabel(place, withCountry)`: "Mesa, Arizona", "Москва, Moscow".

## The files

Under `<base>/places/v1/`, where `<base>` is `NEXT_PUBLIC_HISTORY_URL`. All gzip of JSON, served as
`application/gzip` and never changing (`Cache-Control: public, max-age=31536000, immutable`): a new
build gets a new folder, and `PLACES_PREFIX` in `lib/places.ts` moves to it.

| path | what | size |
|---|---|---|
| `index.json.gz` | licence, source hashes, totals, and a bit per 1° square that holds places | 3.1 KB |
| `n/<lat>_<lon>.json.gz` | the places of a 1° square, named by its south-west corner | 16.6 KB at most, 0.5 KB on average |
| `s/<prefix>.json.gz` | the names that start with these letters | 10.9 KB at most, 0.9 KB on average |

In all: 236,830 places, 58,266 files, 46 MB.

A place is one row: `[name, region, country, lat, lon, weight, zone, other?]`. `region` and `zone`
index the file's `strings`, `country` is the ISO code, the position is in 1e-4 degrees (11 m), and
`weight` is the population, a hundredth of it for a section or a district of a town. The country's name comes from
the browser's own tables (`Intl.DisplayNames`), in the page's language, so no list is downloaded.

**Search.** Each name a place goes by is a line under `nameKey(name)`: lower case, without the accents
people leave out, hyphens and the like as one space. A prefix with 256 names or fewer has them all in
its file. One with more keeps the 256 that count most, and the names that end there, and `next` lists
the letters that go deeper; the reader walks down from the first letter until a file holds all there
is. So a typed name reads one to five files of about 4 KB and a session a few tens of KB, and what
the bucket sees is a prefix. The first letter of Chinese, Japanese, Korean and other names counts as
one letter like any other.

GeoNames' other names have no language in this file. Kept: any that reads differently once
normalized, except addresses, numbers, machine transliterations in small letters ("nyrwby" for
Nairobi), and two letters unless a code in capitals (NY). Of spellings that read alike, the fullest
(München over Munchen). A code keeps the place's usual name on screen ("nyc" shows New York City).

**Nearest.** Reads the point's square, and the squares around it only if a place beyond could still
win (3 rings at most, only squares the index says hold something, so no request fails). "Nearest" is
what a person means by it: the places of `cities500` minus the sections of a town (Times Square,
Jean-Médecin) and the places that are gone (historical, abandoned, destroyed), and a place ten times
larger counts as 1.6 times closer. So a spot in Nice is in Nice, and Times Square is in Manhattan
(3.3 km), not in Weehawken across the river (3.1 km). The numbered districts GeoNames files as towns
(Paris 01 Louvre, Marseille 13) keep their point but answer with their town's name and weight, so a spot
near the Louvre is in Paris. `distance` is the real distance to the name given, or to that district's
point.

## Building and uploading

`pnpm places:build` downloads the dump to `evals/.cache/geonames` and writes under
`evals/.cache/history`, which `DEV_HISTORY_DIR` serves in development. The same dump gives the same
files, byte for byte, with the same Node (fixed gzip header, every sort a total order, whatever the
dump's own order). `index.json.gz` holds the dump's SHA-256; GeoNames does not keep old dumps.
`e2e/history/places` is a small copy for the end-to-end tests, built from the few rows of
`e2e/places-source`: `node scripts/places-build.ts --src e2e/places-source --out e2e/history`.

The bucket's keys live only on Fly, so the upload is a one-shot Machine of the app `unheard-history`,
with its own image. It does not touch the flight job or its schedule. The Machine removes itself:

```
fly deploy --build-only --push --config scripts/history-job.fly.toml -a unheard-history \
  --dockerfile scripts/data-job.Dockerfile --ignorefile scripts/data-job.dockerignore --image-label data-job-N .
fly machine run registry.fly.io/unheard-history:data-job-N --name places-vN --region iad \
  --vm-size shared-cpu-4x --vm-memory 4096 --restart no --rm --detach -a unheard-history \
  --entrypoint "node --max-old-space-size=3500 scripts/places-build.ts --upload"
```

Cost: 46 MB of storage (under a cent a month) and 58,266 uploads once (about 0.30 USD at 0.005 USD per
thousand).
