# The map

`components/PlaceMap.tsx` draws an answer on a real map, with no third party: every byte comes from
our own bucket, next to the flight archive. Neither the home nor the search loads any of it.

```tsx
<PlaceMap guess={guess} others={otherAnswers} sure={sure} />
```

`guess` is a `Guess` of `lib/client/where.worker` (its `mirror` and its `paths`: each plane's track and
closest point). `others` are the other answers, as `{ lat, lon }`. `className` replaces the box's fixed
height (360 px on a phone, 540 px from `sm`), which holds from the first frame to the last, the
fallback included. `archive` replaces the bucket's base, which is `NEXT_PUBLIC_HISTORY_URL`; with none,
the diagram shows.

To look at it without running a search, `/en/dev-map` (or `/fr/dev-map`) has one real answer, with
`?scene=city` for a guess in a dense city and `?archive=<url>` for a bucket on a build that has none. The
route exists in development, and is a 404 in production.

## What it holds

The guess in white with its label, a soft ring around it, the mirror as a hollow dot, the other
answers as small hollow dots, the tracks in amber with a dot at each closest point and the plane's
registration, and the dashed distance rings of `SpotPlot`, under the names of places. Only the answer
has a colour: the map's places of interest show as muted names, without their icons, and nothing else
may print over the guess's label. It frames the
guess, the mirror and the whole tracks, north up. Buttons: zoom in, zoom out, and one that goes between
the spot (zoom 15) and the whole flights. By keyboard: focus the map, arrows pan, `+` and `-` zoom. By
touch: one finger scrolls the page, two move the map. With reduced motion, nothing animates.

The diagram (`SpotPlot`) takes the box, with a line that says so, when there is no WebGL, when the map's
file or the style cannot be read, after three failed files in a row, when the WebGL context is lost, or
if there is no first picture after 25 s.

## Hosting

| path | what | size |
|---|---|---|
| `map/protomaps-20261103.pmtiles` | Protomaps' daily build of the planet, zooms 0 to 15, as it is | 139.3 GB |
| `map/fonts/<font>/<range>.pbf` | Noto Sans, for the labels | 12 MB with the sprite |
| `map/sprites/v4/dark*` | icons and road shields | |

Tiles are read by range requests (`pmtiles`), `Cache-Control: public, max-age=31536000, immutable`. A
new build gets a new name, and `MAP_FILE` in `lib/client/map-style.ts` moves to it; then delete the old
file, or it is paid for twice.

**Zoom 15** because the answer is a spot, and a spot means streets and buildings. It is the build's own
maximum, where Protomaps puts every building and street name, and MapLibre stretches it up to zoom 18.
It also means no cutting: the file is copied as it is, with no disk. Measured on the build of 3 November
(`pmtiles extract --dry-run`):

| up to zoom | size | per month |
|---|---|---|
| 13 | 36 GB | 0.72 USD |
| 14 | 69 GB | 1.38 USD |
| **15** | **139.3 GB** | **2.79 USD** |

**Cost**: 139.3 GB at Tigris's 0.02 USD per GB per month is **2.79 USD a month**. Reads are 0.0005 USD
per thousand with no fee on the bytes that leave, so they barely count. The copy was a performance-2x
Machine for 24 minutes and 2,076 uploads, about 0.10 USD and 0.01 USD, once.

**One look**, measured cold on the real file on 4 November with a production build:

| | first picture | requests | bytes | with the spot too |
|---|---|---|---|---|
| desktop, 1440 px | 3.4 s | 9 | 601 KB | 17 requests, 895 KB |
| phone, 390 px | 2.4 s | 8 | 541 KB | 12 requests, 771 KB |

That is about 228 KB of fonts and 19 to 31 KB of sprite, kept by the browser for a year, and the rest
tiles. A thousand looks at 17 requests each cost under 0.01 USD.

**The bucket's CORS** now also exposes `ETag`, `Content-Range`, `Content-Length` and `Accept-Ranges`.
Any origin may still `GET` and `HEAD`; the flight job's check (`allowAnyOrigin`) still finds what it wants
and leaves the rule alone. There is no Content-Security-Policy on the site to change (`next.config.ts`
sets only `Permissions-Policy` and `X-Frame-Options`). MapLibre's worker is served from our own site: it
is a file of `maplibre-gl`, which Next copies at build.

## Privacy

The page's promise is that nothing is sent, and the map keeps it: the only host asked is the bucket
(`e2e/place-map.spec.ts` fails on any other), and only after a result is on the visitor's own screen.
From then on the bucket sees squares of the map down to zoom 15, about 1 km wide, as `/privacy` says.
That is finer than the 1° squares of the search, on purpose: the answer is already on that screen, and
the visitor is the one looking at it.

## Uploading

The bucket's keys live only on Fly, so it is one-shot Machines of the app `unheard-history`, with their
own image (`scripts/data-job.Dockerfile`, the flight job's image and schedule untouched), which remove
themselves when done. `scripts/map-job.ts` holds what they run:

```
fly deploy --build-only --push --config scripts/history-job.fly.toml -a unheard-history \
  --dockerfile scripts/data-job.Dockerfile --ignorefile scripts/data-job.dockerignore --image-label data-job-N .
fly machine run registry.fly.io/unheard-history:data-job-N --name map-assets --region iad \
  --vm-size shared-cpu-2x --vm-memory 1024 --restart no --rm --detach -a unheard-history \
  --entrypoint "node scripts/map-job.ts --cors --assets"
fly machine run registry.fly.io/unheard-history:data-job-N --name map-planet --region iad \
  --vm-size performance-2x --vm-memory 8192 --restart no --rm --detach -a unheard-history \
  --entrypoint "node scripts/map-job.ts --planet 20261103"
```

The copy checks its size against Protomaps' list of builds, each part with an MD5, and at the end 34
ranges of 256 KB against the build. Protomaps keeps only recent builds, so pick one of `curl
https://build-metadata.protomaps.dev/builds.json`. To take up a copy that stopped, pass the upload id of
its log as `-e MAP_UPLOAD_ID=<id>`.

## Licences

Map data © OpenStreetMap contributors (ODbL 1.0), Protomaps' build (BSD-3 and ODbL), Noto Sans (OFL),
place names from GeoNames (CC BY 4.0, `docs/places-format.md`). The caption under the map says so, with
links; they are only followed on a click.
